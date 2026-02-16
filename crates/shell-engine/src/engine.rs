use monty::{DictPairs, MontyObject};

use crate::icons;
use crate::magic::{self, MagicCommand};
use crate::monty_runtime;
use crate::render::RenderSpec;
use crate::render::LogbookEntry;
use crate::render::TraceEntry;
use crate::session::{PendingMonty, Session};

/// The shell engine — owns REPL state, dispatches commands, returns render specs.
pub struct ShellEngine {
    pub session: Session,
}

impl ShellEngine {
    pub fn new() -> Self {
        Self {
            session: Session::new(),
        }
    }

    /// Get the current prompt string.
    pub fn prompt(&self) -> String {
        "≫ ".to_string()
    }

    /// Evaluate a line of user input.
    /// Returns a render spec (or host call request) as the result.
    pub fn eval(&mut self, input: &str) -> RenderSpec {
        let trimmed = input.trim();

        // Don't record empty input.
        if trimmed.is_empty() {
            return RenderSpec::text("");
        }

        // Record in history.
        self.session.push_history(trimmed);

        // Try magic commands first.
        if let Some(cmd) = magic::parse_magic(trimmed) {
            return self.dispatch_magic(cmd);
        }

        // Auto-resolve: bare entity_id → %get
        if looks_like_entity_id(trimmed) {
            return self.dispatch_magic(MagicCommand::Get(trimmed.to_string()));
        }

        // Auto-resolve: bare domain name → %ls domain
        if looks_like_domain(trimmed) {
            return self.dispatch_magic(MagicCommand::Ls(Some(trimmed.to_string())));
        }

        // Otherwise treat as Python snippet.
        self.eval_python(trimmed)
    }

    /// Dispatch a parsed magic command.
    fn dispatch_magic(&mut self, cmd: MagicCommand) -> RenderSpec {
        match cmd {
            MagicCommand::Help => magic::help_text(),

            MagicCommand::Clear => {
                // Return a special spec that TypeScript interprets as "clear output".
                RenderSpec::text("\x1b[clear]")
            }

            MagicCommand::Ls(domain) => {
                // Request entity list from TypeScript host.
                let call_id = self.session.next_call_id();
                let params = match domain {
                    Some(d) => serde_json::json!({ "domain": d }),
                    None => serde_json::json!({}),
                };
                RenderSpec::host_call(call_id, "get_states", params)
            }

            MagicCommand::Get(entity_id) => {
                let call_id = self.session.next_call_id();
                RenderSpec::host_call(
                    call_id,
                    "get_state",
                    serde_json::json!({ "entity_id": entity_id }),
                )
            }

            MagicCommand::Find(pattern) => {
                let call_id = self.session.next_call_id();
                RenderSpec::host_call(
                    call_id,
                    "find_entities",
                    serde_json::json!({ "pattern": pattern }),
                )
            }

            MagicCommand::Hist { entity_id, hours } => {
                let call_id = self.session.next_call_id();
                RenderSpec::host_call(
                    call_id,
                    "get_history",
                    serde_json::json!({
                        "entity_id": entity_id,
                        "hours": hours.unwrap_or(6),
                    }),
                )
            }

            MagicCommand::Attrs(entity_id) => {
                let call_id = self.session.next_call_id();
                RenderSpec::host_call(
                    call_id,
                    "get_state",
                    serde_json::json!({ "entity_id": entity_id, "attrs_only": true }),
                )
            }

            MagicCommand::Diff(entity_a, entity_b) => {
                // Need both entities — issue two host calls.
                // For now, fetch entity_a first; we'll chain in TS.
                let call_id = self.session.next_call_id();
                RenderSpec::host_call(
                    call_id,
                    "get_diff",
                    serde_json::json!({
                        "entity_a": entity_a,
                        "entity_b": entity_b,
                    }),
                )
            }

            MagicCommand::Bundle(name) => {
                // TODO: bundle loading
                RenderSpec::error(format!("Bundle '{}' not found", name))
            }

            MagicCommand::Fmt(format) => {
                // TODO: store format preference in session
                RenderSpec::text(format!("Output format set to: {}", format))
            }

            MagicCommand::Ask(question) => {
                // Build context from recent shell history.
                let history = self.session.history();
                let recent: Vec<&str> = history.iter().rev().take(10).map(|s| s.as_str()).collect();
                let context = if recent.is_empty() {
                    String::new()
                } else {
                    let cmds: Vec<&str> = recent.into_iter().rev().collect();
                    format!("Recent shell commands:\n{}", cmds.join("\n"))
                };

                let call_id = self.session.next_call_id();
                RenderSpec::host_call(
                    call_id,
                    "conversation_process",
                    serde_json::json!({
                        "text": question,
                        "context": context,
                    }),
                )
            }
        }
    }

    /// Evaluate a Python snippet using the Monty sandboxed interpreter.
    fn eval_python(&mut self, input: &str) -> RenderSpec {
        let context = self.session.python_context_prefix();
        let last_result = self.session.last_result().cloned();
        let result = monty_runtime::eval_python(&context, input, last_result.as_ref());

        // If we got an error AND there was context, the context itself might
        // be the problem (stale variables, changed types, etc.).  Try running
        // the snippet without context — if that succeeds, the context was
        // poisoned, so clear it and use the clean result.  If the retry also
        // fails, keep the original context (the error is in the snippet itself).
        if let monty_runtime::MontyEvalResult::Error(_) = &result {
            if !context.is_empty() {
                let retry = monty_runtime::eval_python("", input, last_result.as_ref());
                if !matches!(&retry, monty_runtime::MontyEvalResult::Error(_)) {
                    // Retry succeeded → context was the problem.  Clear it.
                    self.session.clear_python_context();
                    return self.handle_monty_eval_result(input, "", retry);
                }
                // Both failed → the snippet itself is broken; keep context.
            }
        }

        self.handle_monty_eval_result(input, "", result)
    }

    /// Handle a MontyEvalResult — unified handler for eval_python and resumed executions.
    fn handle_monty_eval_result(
        &mut self,
        input: &str,
        prefix_output: &str,
        result: monty_runtime::MontyEvalResult,
    ) -> RenderSpec {
        match result {
            monty_runtime::MontyEvalResult::Complete { output, result: res } => {
                self.session.push_python_context(input);
                let full_output = combine_output(prefix_output, &output);
                self.render_complete(&full_output, res.as_ref())
            }
            monty_runtime::MontyEvalResult::HostCallNeeded {
                output,
                function_name,
                args,
                snapshot,
            } => {
                let combined = combine_output(prefix_output, &output);

                // Handle show() locally — not a host call.
                if function_name == "show" {
                    self.session.push_python_context(input);
                    if let Some(first_arg) = args.first() {
                        self.session.set_last_result(first_arg.clone());
                    }
                    let mut specs = Vec::new();
                    if !combined.is_empty() {
                        specs.push(RenderSpec::text(combined));
                    }
                    if let Some(first_arg) = args.first() {
                        specs.push(self.format_monty_show(first_arg));
                    }
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                // Handle chart functions locally — no host call needed.
                if matches!(function_name.as_str(), "plot_line" | "plot_bar" | "plot_pie" | "plot_series") {
                    self.session.push_python_context(input);
                    let mut specs = Vec::new();
                    if !combined.is_empty() {
                        specs.push(RenderSpec::text(combined));
                    }
                    specs.push(self.build_chart(&function_name, &args));
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                // Handle ago() locally — pure time calculation, no host call.
                if function_name == "ago" {
                    let result_obj = parse_ago_to_monty(&args);
                    let resume_result = monty_runtime::resume_with_result(
                        snapshot,
                        monty::ExternalResult::Return(result_obj),
                    );
                    return self.handle_monty_eval_result(input, &combined, resume_result);
                }

                match monty_runtime::map_ext_call_to_host_call(&function_name, &args) {
                    Some((method, params)) => {
                        let call_id = self.session.next_call_id();
                        self.session.store_pending_monty(PendingMonty {
                            call_id: call_id.clone(),
                            snapshot,
                            output_so_far: combined,
                            original_snippet: input.to_string(),
                            method: method.to_string(),
                            params: params.clone(),
                        });
                        RenderSpec::host_call(call_id, method, params)
                    }
                    None => RenderSpec::error(format!(
                        "Unknown function: {function_name}"
                    )),
                }
            }
            monty_runtime::MontyEvalResult::Error(msg) => {
                let mut specs = Vec::new();
                if !prefix_output.is_empty() {
                    specs.push(RenderSpec::text(prefix_output.to_string()));
                }
                specs.push(RenderSpec::error(msg));
                if specs.len() == 1 {
                    specs.remove(0)
                } else {
                    RenderSpec::vstack(specs)
                }
            }
        }
    }

    /// Handle the result of a host call.
    /// TypeScript calls this after fulfilling a host_call request.
    pub fn fulfill_host_call(&mut self, call_id: &str, data: &str) -> RenderSpec {
        // Check if this call originated from a Monty execution.
        if self.session.has_pending_monty(call_id) {
            return self.fulfill_monty_host_call(call_id, data);
        }

        // Otherwise it's a magic command host call — parse and format.
        match serde_json::from_str::<serde_json::Value>(data) {
            Ok(value) => {
                // Check for conversation (assistant) response.
                if value.get("__conversation").is_some() {
                    let response = value
                        .get("response")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let agent = value
                        .get("agent_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    return RenderSpec::assistant(response, agent);
                }
                // Check for diff response.
                if value.get("__diff").is_some() {
                    return self.format_diff_response(&value);
                }
                // Check for attrs-only response.
                if value.get("__attrs_only").is_some() {
                    return self.format_attrs_response(&value);
                }
                self.format_host_response(value)
            }
            Err(e) => RenderSpec::error(format!("Failed to parse host response: {e}")),
        }
    }

    /// Resume a paused Monty execution with host call data.
    fn fulfill_monty_host_call(&mut self, call_id: &str, data: &str) -> RenderSpec {
        let pending = match self.session.take_pending_monty(call_id) {
            Some(p) => p,
            None => return RenderSpec::error("No pending Monty execution found."),
        };

        // Convert the JSON response to a MontyObject so Monty can use it.
        let json_value: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(e) => return RenderSpec::error(format!("Failed to parse host response: {e}")),
        };

        // Use typed EntityState for state/states/area responses.
        let monty_value = match pending.method.as_str() {
            "get_state" => monty_runtime::json_to_entity_state(&json_value),
            "get_states" => monty_runtime::json_to_entity_state_list(&json_value),
            "get_area_entities" => {
                // Extract the entities array from the __area envelope.
                if let Some(entities) = json_value.get("entities") {
                    monty_runtime::json_to_entity_state_list(entities)
                } else {
                    // Error response — pass through as generic object.
                    monty_runtime::json_to_monty_obj(&json_value)
                }
            }
            "get_areas" => monty_runtime::json_to_monty_obj(&json_value),
            _ => monty_runtime::json_to_monty_obj(&json_value),
        };

        // Resume the Monty execution with the result.
        let result = monty_runtime::resume_with_result(
            pending.snapshot,
            monty::ExternalResult::Return(monty_value),
        );

        // Combine any output from before the pause with the resumed output.
        match result {
            monty_runtime::MontyEvalResult::Complete { output, result: res } => {
                let full_output = combine_output(&pending.output_so_far, &output);

                // Store `_` for the result.
                if let Some(obj) = &res {
                    self.session.set_last_result(obj.clone());
                } else {
                    self.session.set_last_result(MontyObject::None);
                }

                // Auto-visualize specific methods — render rich displays
                // instead of dumping raw data.
                let is_viz_method = matches!(
                    pending.method.as_str(),
                    "get_history" | "get_statistics" | "get_logbook" | "get_services" | "get_datetime"
                    | "get_trace" | "list_traces"
                );
                if is_viz_method {
                    let mut specs = Vec::new();
                    if !full_output.is_empty() {
                        specs.push(RenderSpec::text(full_output));
                    }
                    let viz = match pending.method.as_str() {
                        "get_logbook" => self.format_logbook_response(json_value, &pending.params),
                        "get_services" => self.format_services_response(json_value),
                        "get_datetime" => self.format_datetime_response(json_value),
                        "get_trace" => self.format_traces_response(json_value, &pending.params),
                        "list_traces" => self.format_traces_response(json_value, &pending.params),
                        _ => self.format_host_response(json_value),
                    };
                    specs.push(viz);
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                self.render_complete(&full_output, res.as_ref())
            }
            monty_runtime::MontyEvalResult::HostCallNeeded {
                output,
                function_name,
                args,
                snapshot,
            } => {
                // Another external call — chain it, carrying the original snippet.
                let combined_output = combine_output(&pending.output_so_far, &output);

                // Handle show() locally — it's not a host call.
                if function_name == "show" {
                    if let Some(first_arg) = args.first() {
                        self.session.set_last_result(first_arg.clone());
                    }
                    let mut specs = Vec::new();
                    if !combined_output.is_empty() {
                        specs.push(RenderSpec::text(combined_output));
                    }
                    if let Some(first_arg) = args.first() {
                        specs.push(self.format_monty_show(first_arg));
                    }
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                // Handle chart functions locally — no host call needed.
                if matches!(function_name.as_str(), "plot_line" | "plot_bar" | "plot_pie" | "plot_series") {
                    let mut specs = Vec::new();
                    if !combined_output.is_empty() {
                        specs.push(RenderSpec::text(combined_output));
                    }
                    specs.push(self.build_chart(&function_name, &args));
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                // Handle ago() locally — pure time calculation.
                if function_name == "ago" {
                    let result_obj = parse_ago_to_monty(&args);
                    let resume_result = monty_runtime::resume_with_result(
                        snapshot,
                        monty::ExternalResult::Return(result_obj),
                    );
                    return self.handle_monty_resumed_result(
                        &pending.original_snippet,
                        &combined_output,
                        resume_result,
                    );
                }

                match monty_runtime::map_ext_call_to_host_call(&function_name, &args) {
                    Some((method, params)) => {
                        let new_call_id = self.session.next_call_id();
                        self.session.store_pending_monty(PendingMonty {
                            call_id: new_call_id.clone(),
                            snapshot,
                            output_so_far: combined_output,
                            original_snippet: pending.original_snippet,
                            method: method.to_string(),
                            params: params.clone(),
                        });
                        RenderSpec::host_call(new_call_id, method, params)
                    }
                    None => RenderSpec::error(format!(
                        "Unknown function: {function_name}"
                    )),
                }
            }
            monty_runtime::MontyEvalResult::Error(msg) => {
                // Error — do NOT commit to context.
                let mut specs = Vec::new();
                if !pending.output_so_far.is_empty() {
                    specs.push(RenderSpec::text(pending.output_so_far));
                }
                specs.push(RenderSpec::error(msg));
                if specs.len() == 1 {
                    specs.remove(0)
                } else {
                    RenderSpec::vstack(specs)
                }
            }
        }
    }

    /// Handle a resumed Monty result in the chained host-call context.
    /// Like fulfill_monty_host_call but for locally-resolved functions (ago, etc).
    fn handle_monty_resumed_result(
        &mut self,
        original_snippet: &str,
        prefix_output: &str,
        result: monty_runtime::MontyEvalResult,
    ) -> RenderSpec {
        match result {
            monty_runtime::MontyEvalResult::Complete { output, result: res } => {
                let full_output = combine_output(prefix_output, &output);
                self.render_complete(&full_output, res.as_ref())
            }
            monty_runtime::MontyEvalResult::HostCallNeeded {
                output,
                function_name,
                args,
                snapshot,
            } => {
                let combined = combine_output(prefix_output, &output);

                if function_name == "show" {
                    if let Some(first_arg) = args.first() {
                        self.session.set_last_result(first_arg.clone());
                    }
                    let mut specs = Vec::new();
                    if !combined.is_empty() {
                        specs.push(RenderSpec::text(combined));
                    }
                    if let Some(first_arg) = args.first() {
                        specs.push(self.format_monty_show(first_arg));
                    }
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                // Handle chart functions locally.
                if matches!(function_name.as_str(), "plot_line" | "plot_bar" | "plot_pie" | "plot_series") {
                    let mut specs = Vec::new();
                    if !combined.is_empty() {
                        specs.push(RenderSpec::text(combined));
                    }
                    specs.push(self.build_chart(&function_name, &args));
                    return if specs.len() == 1 {
                        specs.remove(0)
                    } else {
                        RenderSpec::vstack(specs)
                    };
                }

                if function_name == "ago" {
                    let result_obj = parse_ago_to_monty(&args);
                    let resume_result = monty_runtime::resume_with_result(
                        snapshot,
                        monty::ExternalResult::Return(result_obj),
                    );
                    return self.handle_monty_resumed_result(
                        original_snippet, &combined, resume_result,
                    );
                }

                match monty_runtime::map_ext_call_to_host_call(&function_name, &args) {
                    Some((method, params)) => {
                        let new_call_id = self.session.next_call_id();
                        self.session.store_pending_monty(PendingMonty {
                            call_id: new_call_id.clone(),
                            snapshot,
                            output_so_far: combined,
                            original_snippet: original_snippet.to_string(),
                            method: method.to_string(),
                            params: params.clone(),
                        });
                        RenderSpec::host_call(new_call_id, method, params)
                    }
                    None => RenderSpec::error(format!(
                        "Unknown function: {function_name}"
                    )),
                }
            }
            monty_runtime::MontyEvalResult::Error(msg) => {
                let mut specs = Vec::new();
                if !prefix_output.is_empty() {
                    specs.push(RenderSpec::text(prefix_output.to_string()));
                }
                specs.push(RenderSpec::error(msg));
                if specs.len() == 1 {
                    specs.remove(0)
                } else {
                    RenderSpec::vstack(specs)
                }
            }
        }
    }

    /// Render a completed Monty result — auto-display EntityState richly,
    /// plain text `→ value` for everything else.
    /// Also stores the result as `_` for the next eval.
    fn render_complete(&mut self, output: &str, result: Option<&MontyObject>) -> RenderSpec {
        // Store last result as `_` for subsequent evals.
        if let Some(obj) = result {
            self.session.set_last_result(obj.clone());
        } else {
            self.session.set_last_result(MontyObject::None);
        }

        let mut specs: Vec<RenderSpec> = Vec::new();

        if !output.is_empty() {
            specs.push(RenderSpec::text(output.to_string()));
        }

        if let Some(obj) = result {
            // Rich auto-display for EntityState and lists of EntityState.
            match obj {
                MontyObject::Dataclass { name, .. } if name == "EntityState" => {
                    specs.push(self.format_monty_show(obj));
                }
                MontyObject::List(items)
                    if !items.is_empty()
                        && items.iter().all(|i| {
                            matches!(i, MontyObject::Dataclass { name, .. } if name == "EntityState")
                        }) =>
                {
                    specs.push(self.format_monty_show(obj));
                }
                other => {
                    specs.push(RenderSpec::text(format!("→ {other}")));
                }
            }
        }

        match specs.len() {
            0 => RenderSpec::text(""),
            1 => specs.remove(0),
            _ => RenderSpec::vstack(specs),
        }
    }

    /// Format a MontyObject for show() — rich rendering for EntityState,
    /// plain text for everything else.
    fn format_monty_show(&self, obj: &MontyObject) -> RenderSpec {
        match obj {
            MontyObject::Dataclass {
                name, attrs, ..
            } if name == "EntityState" => {
                self.format_entity_state_card(attrs)
            }
            MontyObject::List(items) => {
                // Check if it's a list of EntityState — render as table.
                let all_entity_states = !items.is_empty()
                    && items.iter().all(|item| {
                        matches!(item, MontyObject::Dataclass { name, .. } if name == "EntityState")
                    });
                if all_entity_states {
                    self.format_entity_state_table(items)
                } else {
                    RenderSpec::text(format!("{obj}"))
                }
            }
            other => RenderSpec::text(format!("{other}")),
        }
    }

    /// Render an EntityState dataclass as a rich entity card.
    fn format_entity_state_card(&self, attrs: &monty::DictPairs) -> RenderSpec {
        let get_str = |key: &str| -> String {
            for (k, v) in attrs {
                if let MontyObject::String(k_str) = k {
                    if k_str == key {
                        if let MontyObject::String(s) = v {
                            return s.clone();
                        }
                    }
                }
            }
            String::new()
        };
        let get_bool = |key: &str| -> bool {
            for (k, v) in attrs {
                if let MontyObject::String(k_str) = k {
                    if k_str == key {
                        if let MontyObject::Bool(b) = v {
                            return *b;
                        }
                    }
                }
            }
            false
        };

        let entity_id = get_str("entity_id");
        let state = get_str("state");
        let domain = get_str("domain");
        let name = get_str("name");
        let last_changed = get_str("last_changed");
        let _is_on = get_bool("is_on");

        // Extract device_class and unit from the attributes dict.
        let mut device_class: Option<String> = None;
        let mut unit: Option<String> = None;
        let mut attr_pairs: Vec<(String, String)> = Vec::new();
        let skip_keys = [
            "friendly_name",
            "icon",
            "entity_picture",
            "supported_features",
            "attribution",
        ];

        for (k, v) in attrs {
            if let MontyObject::String(k_str) = k {
                if k_str == "attributes" {
                    if let MontyObject::Dict(inner_attrs) = v {
                        for (ak, av) in inner_attrs {
                            if let MontyObject::String(ak_str) = ak {
                                if ak_str == "device_class" {
                                    if let MontyObject::String(s) = av {
                                        device_class = Some(s.clone());
                                    }
                                } else if ak_str == "unit_of_measurement" {
                                    if let MontyObject::String(s) = av {
                                        unit = Some(s.clone());
                                    }
                                }
                                if !skip_keys.contains(&ak_str.as_str()) {
                                    attr_pairs.push((ak_str.clone(), format!("{av}")));
                                }
                            }
                        }
                    }
                }
            }
        }

        let icon = crate::icons::entity_icon(
            &entity_id,
            device_class.as_deref(),
            Some(&state),
        );
        let state_color = crate::icons::state_color(&state);
        let time_str = format_timestamp(&last_changed);

        RenderSpec::entity_card(
            entity_id,
            icon,
            name,
            state,
            state_color,
            unit,
            domain,
            device_class,
            time_str,
            attr_pairs,
        )
    }

    /// Render a list of EntityState dataclasses as a table with summary.
    fn format_entity_state_table(&self, items: &[MontyObject]) -> RenderSpec {
        let headers = vec![
            " ".into(),
            "entity_id".into(),
            "state".into(),
            "last_changed".into(),
        ];

        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut domain_counts: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();

        for item in items {
            if let MontyObject::Dataclass { attrs, .. } = item {
                let get_str = |key: &str| -> String {
                    for (k, v) in attrs {
                        if let MontyObject::String(k_str) = k {
                            if k_str == key {
                                if let MontyObject::String(s) = v {
                                    return s.clone();
                                }
                            }
                        }
                    }
                    String::new()
                };

                let entity_id = get_str("entity_id");
                let state = get_str("state");
                let domain = get_str("domain");
                let last_changed = get_str("last_changed");

                // Extract device_class and unit from nested attributes.
                let mut device_class: Option<String> = None;
                let mut unit: Option<String> = None;
                for (k, v) in attrs {
                    if let MontyObject::String(k_str) = k {
                        if k_str == "attributes" {
                            if let MontyObject::Dict(inner) = v {
                                for (ak, av) in inner {
                                    if let MontyObject::String(ak_str) = ak {
                                        if ak_str == "device_class" {
                                            if let MontyObject::String(s) = av {
                                                device_class = Some(s.clone());
                                            }
                                        } else if ak_str == "unit_of_measurement" {
                                            if let MontyObject::String(s) = av {
                                                unit = Some(s.clone());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                let icon = crate::icons::entity_icon(
                    &entity_id,
                    device_class.as_deref(),
                    Some(&state),
                );
                let indicator = crate::icons::state_indicator(&state);
                let time_str = format_timestamp(&last_changed);
                let state_display = match unit {
                    Some(u) if state.parse::<f64>().is_ok() => format!("{state} {u}"),
                    _ => state.clone(),
                };

                rows.push(vec![
                    format!("{icon} {indicator}"),
                    entity_id.clone(),
                    state_display,
                    time_str,
                ]);

                *domain_counts.entry(domain).or_insert(0) += 1;
            }
        }

        let domain_parts: Vec<String> = domain_counts
            .iter()
            .map(|(d, c)| format!("{d}: {c}"))
            .collect();
        let summary_text = format!(
            "{} entities  ({})",
            items.len(),
            domain_parts.join(", ")
        );

        RenderSpec::vstack(vec![
            RenderSpec::summary(summary_text),
            RenderSpec::table(headers, rows),
        ])
    }

    /// Format a host call response into a render spec.
    fn format_host_response(&self, value: serde_json::Value) -> RenderSpec {
        // If it's an array of state objects, render as a table with summary.
        if let Some(arr) = value.as_array() {
            if arr.is_empty() {
                return RenderSpec::text("No results.");
            }

            // Check if it's a history response: array of arrays.
            if arr[0].is_array() {
                return self.format_history_response(&value);
            }

            // Check if items look like HA state objects.
            if arr[0].get("entity_id").is_some() {
                return self.format_entity_table(arr);
            }
        }

        // Check if it's a statistics response: object with entity_id keys containing arrays.
        if let Some(obj) = value.as_object() {
            if let Some(first_val) = obj.values().next() {
                if first_val.is_array() {
                    if let Some(first_item) = first_val.as_array().and_then(|a| a.first()) {
                        if first_item.get("start").is_some() && first_item.get("end").is_some() {
                            return self.format_statistics_response(&value);
                        }
                    }
                }
            }
        }

        // If it's a single state object, render as rich entity card.
        if value.get("entity_id").is_some() {
            return self.format_entity_card(&value);
        }

        // Fallback: pretty-print JSON in a copyable block.
        let pretty = serde_json::to_string_pretty(&value)
            .unwrap_or_else(|_| value.to_string());
        RenderSpec::copyable(pretty, Some("JSON".into()))
    }

    /// Format an array of HA state objects into a table with summary.
    fn format_entity_table(&self, arr: &[serde_json::Value]) -> RenderSpec {
        let headers = vec![
            " ".into(),
            "entity_id".into(),
            "state".into(),
            "last_changed".into(),
        ];
        let rows: Vec<Vec<String>> = arr
            .iter()
            .map(|item| {
                let entity_id = item
                    .get("entity_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let state = item
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let device_class = item
                    .get("attributes")
                    .and_then(|a| a.get("device_class"))
                    .and_then(|v| v.as_str());
                let unit = item
                    .get("attributes")
                    .and_then(|a| a.get("unit_of_measurement"))
                    .and_then(|v| v.as_str());
                let icon = icons::entity_icon(entity_id, device_class, Some(state));
                let indicator = icons::state_indicator(state);
                let last_changed = item
                    .get("last_changed")
                    .and_then(|v| v.as_str())
                    .unwrap_or("-");
                let time_str = format_timestamp(last_changed);

                // Append unit to numeric states.
                let state_display = match unit {
                    Some(u) if state.parse::<f64>().is_ok() => format!("{state} {u}"),
                    _ => state.to_string(),
                };

                vec![
                    format!("{icon} {indicator}"),
                    entity_id.to_string(),
                    state_display,
                    time_str,
                ]
            })
            .collect();

        // Count by domain for summary.
        let mut domain_counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for item in arr {
            if let Some(eid) = item.get("entity_id").and_then(|v| v.as_str()) {
                let domain = eid.split('.').next().unwrap_or("?");
                *domain_counts.entry(domain.to_string()).or_insert(0) += 1;
            }
        }
        let domain_parts: Vec<String> = domain_counts
            .iter()
            .map(|(d, c)| format!("{d}: {c}"))
            .collect();
        let summary_text = format!(
            "{} entities  ({})",
            arr.len(),
            domain_parts.join(", ")
        );

        RenderSpec::vstack(vec![
            RenderSpec::summary(summary_text),
            RenderSpec::table(headers, rows),
        ])
    }

    /// Format a history API response into a sparkline or timeline.
    ///
    /// History API returns `[[{entity_id, state, last_changed}, ...]]`.
    /// Numeric entities → sparkline, binary/discrete → timeline.
    fn format_history_response(&self, value: &serde_json::Value) -> RenderSpec {
        let outer = match value.as_array() {
            Some(arr) => arr,
            None => return RenderSpec::error("Invalid history response format."),
        };

        if outer.is_empty() || outer[0].as_array().map_or(true, |a| a.is_empty()) {
            return RenderSpec::text("No history data.");
        }

        let mut specs = Vec::new();

        for entity_history in outer {
            let arr = match entity_history.as_array() {
                Some(a) if !a.is_empty() => a,
                _ => continue,
            };

            let entity_id = arr[0]
                .get("entity_id")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            let name = arr[0]
                .get("attributes")
                .and_then(|a| a.get("friendly_name"))
                .and_then(|v| v.as_str())
                .unwrap_or(&entity_id)
                .to_string();

            // Detect if numeric — try parsing first few states.
            let is_numeric = arr.iter().take(5).any(|entry| {
                entry
                    .get("state")
                    .and_then(|v| v.as_str())
                    .map(|s| s.parse::<f64>().is_ok())
                    .unwrap_or(false)
            });

            if is_numeric {
                // Build sparkline from numeric states.
                let mut points: Vec<(f64, f64)> = Vec::new();
                let unit = arr[0]
                    .get("attributes")
                    .and_then(|a| a.get("unit_of_measurement"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                for entry in arr {
                    let state_str = entry
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if let Ok(val) = state_str.parse::<f64>() {
                        let ts = entry
                            .get("last_changed")
                            .and_then(|v| v.as_str())
                            .and_then(parse_iso_to_ms)
                            .unwrap_or(0.0);
                        points.push((ts, val));
                    }
                }

                if !points.is_empty() {
                    specs.push(RenderSpec::sparkline(entity_id, name, unit, points));
                }
            } else {
                // Build timeline from discrete states.
                let mut segments: Vec<(f64, f64, String, String)> = Vec::new();
                let start_time = arr
                    .first()
                    .and_then(|e| e.get("last_changed").and_then(|v| v.as_str()))
                    .and_then(parse_iso_to_ms)
                    .unwrap_or(0.0);
                let end_time = arr
                    .last()
                    .and_then(|e| e.get("last_changed").and_then(|v| v.as_str()))
                    .and_then(parse_iso_to_ms)
                    .unwrap_or(start_time);

                for i in 0..arr.len() {
                    let state = arr[i]
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let seg_start = arr[i]
                        .get("last_changed")
                        .and_then(|v| v.as_str())
                        .and_then(parse_iso_to_ms)
                        .unwrap_or(start_time);
                    let seg_end = if i + 1 < arr.len() {
                        arr[i + 1]
                            .get("last_changed")
                            .and_then(|v| v.as_str())
                            .and_then(parse_iso_to_ms)
                            .unwrap_or(end_time)
                    } else {
                        // Last segment extends to now (or end_time if in the past).
                        end_time
                    };

                    let color = state_to_timeline_color(&state);
                    segments.push((seg_start, seg_end, state, color));
                }

                if !segments.is_empty() {
                    specs.push(RenderSpec::timeline(
                        entity_id, name, segments, start_time, end_time,
                    ));
                }
            }
        }

        match specs.len() {
            0 => RenderSpec::text("No displayable history data."),
            1 => specs.remove(0),
            _ => RenderSpec::vstack(specs),
        }
    }

    /// Format a statistics API response into a sparkline.
    ///
    /// Statistics API returns `{entity_id: [{start, end, mean, min, max, ...}]}`.
    fn format_statistics_response(&self, value: &serde_json::Value) -> RenderSpec {
        let obj = match value.as_object() {
            Some(o) => o,
            None => return RenderSpec::error("Invalid statistics response format."),
        };

        if obj.is_empty() {
            return RenderSpec::text("No statistics data.");
        }

        let mut specs = Vec::new();

        for (entity_id, stats_value) in obj {
            let stats = match stats_value.as_array() {
                Some(a) if !a.is_empty() => a,
                _ => continue,
            };

            // Use mean if available, fall back to state.
            let mut points: Vec<(f64, f64)> = Vec::new();
            for entry in stats {
                let ts = entry
                    .get("start")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                // Statistics timestamps are in seconds (epoch) — convert to ms.
                let ts_ms = ts * 1000.0;

                let val = entry
                    .get("mean")
                    .and_then(|v| v.as_f64())
                    .or_else(|| entry.get("state").and_then(|v| v.as_f64()))
                    .or_else(|| entry.get("sum").and_then(|v| v.as_f64()));

                if let Some(v) = val {
                    points.push((ts_ms, v));
                }
            }

            if !points.is_empty() {
                // For now, use entity_id as the name — we don't have friendly_name in statistics.
                specs.push(RenderSpec::sparkline(
                    entity_id.clone(),
                    entity_id.clone(),
                    None,
                    points,
                ));
            }
        }

        match specs.len() {
            0 => RenderSpec::text("No displayable statistics data."),
            1 => specs.remove(0),
            _ => RenderSpec::vstack(specs),
        }
    }

    /// Format a logbook API response into a rich logbook display.
    ///
    /// Logbook API returns an array of entry objects with:
    /// `when`, `name`, `state`, `message`, `entity_id`,
    /// `context_user`, `context_event`, `context_domain`, `context_service`,
    /// `context_entity`, `context_entity_name`.
    fn format_logbook_response(
        &self,
        value: serde_json::Value,
        params: &serde_json::Value,
    ) -> RenderSpec {
        let entity_id = params
            .get("entity_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let arr = match value.as_array() {
            Some(a) => a,
            None => return RenderSpec::error("Invalid logbook response format."),
        };

        if arr.is_empty() {
            return RenderSpec::text("No logbook entries.");
        }

        let entries: Vec<LogbookEntry> = arr
            .iter()
            .map(|e| LogbookEntry {
                when: e
                    .get("when")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                name: e
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                state: e.get("state").and_then(|v| v.as_str()).map(|s| s.to_string()),
                message: e
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                entity_id: e
                    .get("entity_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_user: e
                    .get("context_user")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_event: e
                    .get("context_event")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_domain: e
                    .get("context_domain")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_service: e
                    .get("context_service")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_entity: e
                    .get("context_entity")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_entity_name: e
                    .get("context_entity_name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
            .collect();

        let count = entries.len();
        let summary_text = format!("{} logbook entries for {}", count, entity_id);

        RenderSpec::vstack(vec![
            RenderSpec::summary(summary_text),
            RenderSpec::logbook(entity_id, entries),
        ])
    }

    /// Format a traces response (get_trace or list_traces) into a rich trace list.
    ///
    /// Input: JSON array of `{run_id, automation?, state, start, finish?, trigger?, last_step?, execution?, error?}`.
    fn format_traces_response(
        &self,
        value: serde_json::Value,
        params: &serde_json::Value,
    ) -> RenderSpec {
        let arr = match value.as_array() {
            Some(a) => a,
            None => return RenderSpec::error("Invalid traces response format."),
        };

        if arr.is_empty() {
            return RenderSpec::text("No traces found.");
        }

        let automation_id = params
            .get("automation_id")
            .and_then(|v| v.as_str())
            .map(|s| {
                if s.starts_with("automation.") {
                    s.to_string()
                } else {
                    format!("automation.{s}")
                }
            });

        let entries: Vec<TraceEntry> = arr
            .iter()
            .map(|e| TraceEntry {
                run_id: e
                    .get("run_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                automation: e
                    .get("automation")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                state: e
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                start: e
                    .get("start")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                finish: e
                    .get("finish")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                trigger: e
                    .get("trigger")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                last_step: e
                    .get("last_step")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                execution: e
                    .get("execution")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                error: e
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
            .collect();

        let count = entries.len();
        let title = match &automation_id {
            Some(id) => format!("{count} traces for {id}"),
            None => format!("{count} recent automation traces"),
        };

        RenderSpec::vstack(vec![
            RenderSpec::summary(title),
            RenderSpec::trace_list(automation_id, entries),
        ])
    }

    /// Format a services list response into a table.
    ///
    /// Input: JSON array of `{domain, service, name, description, fields}`.
    fn format_services_response(&self, value: serde_json::Value) -> RenderSpec {
        let arr = match value.as_array() {
            Some(a) => a,
            None => return RenderSpec::error("Invalid services response format."),
        };

        if arr.is_empty() {
            return RenderSpec::text("No services found.");
        }

        let headers = vec![
            "domain".into(),
            "service".into(),
            "name".into(),
            "fields".into(),
        ];

        let rows: Vec<Vec<String>> = arr
            .iter()
            .map(|e| {
                let domain = e.get("domain").and_then(|v| v.as_str()).unwrap_or("-");
                let service = e.get("service").and_then(|v| v.as_str()).unwrap_or("-");
                let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("-");
                let fields = e
                    .get("fields")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|f| f.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                vec![
                    domain.to_string(),
                    service.to_string(),
                    name.to_string(),
                    fields,
                ]
            })
            .collect();

        // Count by domain for summary.
        let mut domain_counts: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        for item in arr {
            if let Some(d) = item.get("domain").and_then(|v| v.as_str()) {
                *domain_counts.entry(d.to_string()).or_insert(0) += 1;
            }
        }
        let domain_parts: Vec<String> = domain_counts
            .iter()
            .map(|(d, c)| format!("{d}: {c}"))
            .collect();
        let summary_text = format!(
            "{} services  ({})",
            arr.len(),
            domain_parts.join(", ")
        );

        RenderSpec::vstack(vec![
            RenderSpec::summary(summary_text),
            RenderSpec::table(headers, rows),
        ])
    }

    /// Format a datetime response into a key-value display.
    fn format_datetime_response(&self, value: serde_json::Value) -> RenderSpec {
        let mut pairs = Vec::new();

        if let Some(date) = value.get("date").and_then(|v| v.as_str()) {
            pairs.push(("date".to_string(), date.to_string()));
        }
        if let Some(time) = value.get("time").and_then(|v| v.as_str()) {
            pairs.push(("time".to_string(), time.to_string()));
        }
        if let Some(day) = value.get("day_of_week").and_then(|v| v.as_str()) {
            pairs.push(("day".to_string(), day.to_string()));
        }
        if let Some(tz) = value.get("timezone").and_then(|v| v.as_str()) {
            pairs.push(("timezone".to_string(), tz.to_string()));
        }
        if let Some(ha_tz) = value.get("ha_timezone").and_then(|v| v.as_str()) {
            if ha_tz != value.get("timezone").and_then(|v| v.as_str()).unwrap_or("") {
                pairs.push(("ha_timezone".to_string(), ha_tz.to_string()));
            }
        }
        if let Some(iso) = value.get("iso").and_then(|v| v.as_str()) {
            pairs.push(("iso".to_string(), iso.to_string()));
        }

        if pairs.is_empty() {
            // Fallback — just dump as JSON.
            let pretty =
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
            return RenderSpec::copyable(pretty, Some("datetime".into()));
        }

        RenderSpec::key_value(Some("  now".to_string()), pairs)
    }

    /// Format a single HA state object as a rich entity card.
    fn format_entity_card(&self, value: &serde_json::Value) -> RenderSpec {
        let entity_id = value
            .get("entity_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let state = value
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let domain = entity_id.split('.').next().unwrap_or("?");
        let device_class = value
            .get("attributes")
            .and_then(|a| a.get("device_class"))
            .and_then(|v| v.as_str());
        let friendly_name = value
            .get("attributes")
            .and_then(|a| a.get("friendly_name"))
            .and_then(|v| v.as_str());
        let unit = value
            .get("attributes")
            .and_then(|a| a.get("unit_of_measurement"))
            .and_then(|v| v.as_str());
        let last_changed = value
            .get("last_changed")
            .and_then(|v| v.as_str())
            .unwrap_or("-");

        let icon = icons::entity_icon(entity_id, device_class, Some(state));
        let state_color = icons::state_color(state);
        let name = friendly_name.unwrap_or(entity_id);
        let time_str = format_timestamp(last_changed);

        // Build attribute pairs, filtering out internal/display ones.
        let skip_keys = [
            "friendly_name",
            "icon",
            "entity_picture",
            "supported_features",
            "attribution",
        ];
        let attributes: Vec<(String, String)> = value
            .get("attributes")
            .and_then(|a| a.as_object())
            .map(|obj| {
                obj.iter()
                    .filter(|(k, _)| !skip_keys.contains(&k.as_str()))
                    .map(|(k, v)| {
                        let val_str = match v {
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Bool(b) => b.to_string(),
                            serde_json::Value::Number(n) => n.to_string(),
                            serde_json::Value::Null => "null".to_string(),
                            other => serde_json::to_string(other).unwrap_or_default(),
                        };
                        (k.clone(), val_str)
                    })
                    .collect()
            })
            .unwrap_or_default();

        RenderSpec::entity_card(
            entity_id,
            icon,
            name,
            state,
            state_color,
            unit.map(|u| u.to_string()),
            domain,
            device_class.map(|dc| dc.to_string()),
            time_str,
            attributes,
        )
    }

    /// Format an attrs-only response as a key-value table.
    fn format_attrs_response(&self, value: &serde_json::Value) -> RenderSpec {
        let entity = value.get("entity").unwrap_or(value);
        let entity_id = entity
            .get("entity_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?");

        let pairs: Vec<(String, String)> = entity
            .get("attributes")
            .and_then(|a| a.as_object())
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| {
                        let val_str = match v {
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Bool(b) => b.to_string(),
                            serde_json::Value::Number(n) => n.to_string(),
                            serde_json::Value::Null => "null".to_string(),
                            other => serde_json::to_string(other).unwrap_or_default(),
                        };
                        (k.clone(), val_str)
                    })
                    .collect()
            })
            .unwrap_or_default();

        if pairs.is_empty() {
            return RenderSpec::text(format!("{entity_id} has no attributes."));
        }

        RenderSpec::key_value(
            Some(format!("Attributes — {entity_id}")),
            pairs,
        )
    }

    /// Format a diff response comparing two entities.
    fn format_diff_response(&self, value: &serde_json::Value) -> RenderSpec {
        let entity_a = value.get("entity_a").unwrap_or(&serde_json::Value::Null);
        let entity_b = value.get("entity_b").unwrap_or(&serde_json::Value::Null);

        let id_a = entity_a
            .get("entity_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let id_b = entity_b
            .get("entity_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let state_a = entity_a
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let state_b = entity_b
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("?");

        // Build comparison table.
        let mut rows: Vec<Vec<String>> = Vec::new();
        rows.push(vec!["state".into(), state_a.to_string(), state_b.to_string()]);

        // Collect all attribute keys from both entities.
        let attrs_a = entity_a.get("attributes").and_then(|a| a.as_object());
        let attrs_b = entity_b.get("attributes").and_then(|a| a.as_object());

        let mut all_keys: Vec<String> = Vec::new();
        if let Some(a) = attrs_a {
            for k in a.keys() {
                if !all_keys.contains(k) {
                    all_keys.push(k.clone());
                }
            }
        }
        if let Some(b) = attrs_b {
            for k in b.keys() {
                if !all_keys.contains(k) {
                    all_keys.push(k.clone());
                }
            }
        }
        all_keys.sort();

        let skip_keys = ["friendly_name", "icon", "entity_picture", "supported_features"];
        for key in &all_keys {
            if skip_keys.contains(&key.as_str()) {
                continue;
            }
            let val_a = attrs_a
                .and_then(|a| a.get(key))
                .map(|v| format_json_value(v))
                .unwrap_or_else(|| "—".to_string());
            let val_b = attrs_b
                .and_then(|b| b.get(key))
                .map(|v| format_json_value(v))
                .unwrap_or_else(|| "—".to_string());
            rows.push(vec![key.clone(), val_a, val_b]);
        }

        let headers = vec!["attribute".into(), id_a.to_string(), id_b.to_string()];

        RenderSpec::vstack(vec![
            RenderSpec::summary(format!("Comparing {id_a} ↔ {id_b}")),
            RenderSpec::table(headers, rows),
        ])
    }

    // -----------------------------------------------------------------------
    // Chart functions — local handling (like show/ago)
    // -----------------------------------------------------------------------

    /// Build a RenderSpec for a chart call (plot_line, plot_bar, plot_pie).
    /// Returns the chart spec directly — no host call needed.
    fn build_chart(&self, function_name: &str, args: &[MontyObject]) -> RenderSpec {
        match function_name {
            "plot_line" => self.build_line_or_bar_chart("line", args),
            "plot_bar" => self.build_line_or_bar_chart("bar", args),
            "plot_pie" => self.build_pie_chart(args),
            "plot_series" => self.build_series_chart(args),
            _ => RenderSpec::error(format!("Unknown chart function: {function_name}")),
        }
    }

    /// Build a line or bar chart from args:
    ///   plot_line(labels, values, title?)
    ///   plot_line(labels, {"Series A": [...], "Series B": [...]}, title?)
    /// or dict form:
    ///   plot_line({"labels": [...], "series": {...}}, title?)
    fn build_line_or_bar_chart(&self, chart_type: &str, args: &[MontyObject]) -> RenderSpec {
        let (labels, series_map, title) = match self.parse_xy_args(args) {
            Ok(v) => v,
            Err(e) => return RenderSpec::error(e),
        };

        let mut echarts_series = Vec::new();
        for (name, values) in &series_map {
            echarts_series.push(serde_json::json!({
                "name": name,
                "type": chart_type,
                "data": values,
                "smooth": chart_type == "line",
            }));
        }

        let option = serde_json::json!({
            "tooltip": { "trigger": "axis" },
            "legend": { "data": series_map.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>() },
            "xAxis": { "type": "category", "data": labels },
            "yAxis": { "type": "value" },
            "series": echarts_series,
            "grid": { "left": "10%", "right": "5%", "bottom": "15%", "top": "15%" },
        });

        RenderSpec::echarts(option, title, None)
    }

    /// Build a pie chart from args:
    ///   plot_pie({"Living Room": 3, "Kitchen": 5, "Bedroom": 2}, title?)
    ///   plot_pie([("Living Room", 3), ("Kitchen", 5)], title?)
    fn build_pie_chart(&self, args: &[MontyObject]) -> RenderSpec {
        let (data, title) = match self.parse_pie_args(args) {
            Ok(v) => v,
            Err(e) => return RenderSpec::error(e),
        };

        let pie_data: Vec<serde_json::Value> = data
            .iter()
            .map(|(name, value)| serde_json::json!({ "name": name, "value": value }))
            .collect();

        let option = serde_json::json!({
            "tooltip": { "trigger": "item", "formatter": "{b}: {c} ({d}%)" },
            "legend": { "orient": "vertical", "left": "left" },
            "series": [{
                "type": "pie",
                "radius": "60%",
                "data": pie_data,
                "emphasis": {
                    "itemStyle": {
                        "shadowBlur": 10,
                        "shadowOffsetX": 0,
                        "shadowColor": "rgba(0, 0, 0, 0.5)"
                    }
                }
            }],
        });

        RenderSpec::echarts(option, title, None)
    }

    /// Build a time-series / XY scatter chart from args:
    ///   plot_series([(x, y), ...], title?)                  — single series
    ///   plot_series({"name": [(x, y), ...], ...}, title?)   — multi-series
    ///
    /// If x values look like epoch milliseconds (> 1_000_000_000_000), the x-axis
    /// is rendered as an ECharts `time` axis. Otherwise it's a `value` axis.
    fn build_series_chart(&self, args: &[MontyObject]) -> RenderSpec {
        if args.is_empty() {
            return RenderSpec::error(
                "plot_series requires at least 1 argument: [(x,y),...] or {\"name\": [(x,y),...]}",
            );
        }

        let title = self.extract_title_from_args(args, 1);

        // Parse into named series of (x, y) pairs.
        let named_series: Vec<(String, Vec<(f64, f64)>)> = match &args[0] {
            // Dict form: {"name": [(x,y), ...], ...}
            MontyObject::Dict(pairs) => {
                let mut series = Vec::new();
                for (k, v) in pairs {
                    let name = match k {
                        MontyObject::String(s) => s.clone(),
                        other => format!("{other}"),
                    };
                    let points = match self.monty_to_xy_points(v) {
                        Some(pts) => pts,
                        None => return RenderSpec::error(
                            format!("Series '{name}' must be a list of (x, y) pairs"),
                        ),
                    };
                    series.push((name, points));
                }
                series
            }
            // List form: [(x, y), ...]
            MontyObject::List(_) => {
                match self.monty_to_xy_points(&args[0]) {
                    Some(pts) => vec![("value".into(), pts)],
                    None => return RenderSpec::error(
                        "Argument must be a list of (x, y) pairs or a dict of named series",
                    ),
                }
            }
            _ => return RenderSpec::error(
                "plot_series requires [(x,y),...] or {\"name\": [(x,y),...]}",
            ),
        };

        if named_series.is_empty() || named_series.iter().all(|(_, pts)| pts.is_empty()) {
            return RenderSpec::error("plot_series: no data points provided");
        }

        // Auto-detect time axis: if any x value > 1 trillion, treat as epoch ms.
        let is_time = named_series.iter().any(|(_, pts)| {
            pts.iter().any(|(x, _)| *x > 1_000_000_000_000.0)
        });

        let x_axis = if is_time {
            serde_json::json!({ "type": "time" })
        } else {
            serde_json::json!({ "type": "value" })
        };

        let echarts_series: Vec<serde_json::Value> = named_series
            .iter()
            .map(|(name, pts)| {
                let data: Vec<serde_json::Value> = pts
                    .iter()
                    .map(|(x, y)| serde_json::json!([x, y]))
                    .collect();
                let mut s = serde_json::json!({
                    "type": "line",
                    "name": name,
                    "data": data,
                    "showSymbol": data.len() <= 50,
                    "smooth": false,
                });
                // Hide dots for dense time-series
                if data.len() > 50 {
                    s.as_object_mut().unwrap().insert(
                        "symbolSize".into(),
                        serde_json::json!(0),
                    );
                }
                s
            })
            .collect();

        let show_legend = named_series.len() > 1
            || (named_series.len() == 1 && named_series[0].0 != "value");

        let option = serde_json::json!({
            "tooltip": {
                "trigger": "axis",
                "axisPointer": { "type": "cross" },
            },
            "legend": { "show": show_legend },
            "grid": { "left": "12%", "right": "5%", "bottom": "15%", "top": "12%" },
            "xAxis": x_axis,
            "yAxis": { "type": "value" },
            "series": echarts_series,
        });

        RenderSpec::echarts(option, title, None)
    }

    /// Extract a list of (x, y) numeric pairs from a MontyObject.
    /// Accepts List of Tuple([x, y]) or List([x, y]).
    fn monty_to_xy_points(&self, obj: &MontyObject) -> Option<Vec<(f64, f64)>> {
        if let MontyObject::List(items) = obj {
            let mut points = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    MontyObject::Tuple(pair) if pair.len() == 2 => {
                        let x = self.monty_to_f64(&pair[0])?;
                        let y = self.monty_to_f64(&pair[1])?;
                        points.push((x, y));
                    }
                    MontyObject::List(pair) if pair.len() == 2 => {
                        let x = self.monty_to_f64(&pair[0])?;
                        let y = self.monty_to_f64(&pair[1])?;
                        points.push((x, y));
                    }
                    _ => return None,
                }
            }
            Some(points)
        } else {
            None
        }
    }

    /// Parse arguments for plot_line / plot_bar.
    /// Supported forms:
    ///   (labels_list, values_list, title?)
    ///   (labels_list, {"name": values_list, ...}, title?)
    ///   ({"labels": [...], "values": [...] or "series": {...}}, title?)
    fn parse_xy_args(
        &self,
        args: &[MontyObject],
    ) -> Result<(Vec<String>, Vec<(String, Vec<f64>)>, Option<String>), String> {
        if args.is_empty() {
            return Err("plot_line/plot_bar requires at least 1 argument: (labels, values) or a dict with 'labels' and 'values' keys".into());
        }

        // Check for dict form: {"labels": [...], "values": [...]} or {"labels": [...], "series": {...}}
        if let MontyObject::Dict(pairs) = &args[0] {
            let has_labels = dict_has_key(pairs, "labels");
            if has_labels {
                let labels = self.extract_string_list(pairs, "labels")?;
                let title = self.extract_title_from_args(args, 1);

                // Check for "values" (single series) or "series" (multi-series dict)
                let has_series = dict_has_key(pairs, "series");
                if has_series {
                    let series = self.extract_series_dict(pairs)?;
                    return Ok((labels, series, title));
                }
                let values = self.extract_number_list(pairs, "values")?;
                return Ok((labels, vec![("value".into(), values)], title));
            }
        }

        // Positional form: (labels, values, title?)
        if args.len() < 2 {
            return Err("plot_line/plot_bar requires (labels, values) or a dict with 'labels' and 'values' keys".into());
        }

        let labels = self.monty_to_string_list(&args[0])
            .ok_or_else(|| "First argument must be a list of labels (strings)".to_string())?;

        let title = self.extract_title_from_args(args, 2);

        // values can be a list of numbers (single series) or a dict of named series
        match &args[1] {
            MontyObject::Dict(pairs) => {
                let mut series = Vec::new();
                for (k, v) in pairs {
                    let name = match k {
                        MontyObject::String(s) => s.clone(),
                        other => format!("{other}"),
                    };
                    let values = self.monty_to_number_list(v)
                        .ok_or_else(|| format!("Series '{name}' must be a list of numbers"))?;
                    series.push((name, values));
                }
                Ok((labels, series, title))
            }
            list => {
                let values = self.monty_to_number_list(list)
                    .ok_or_else(|| "Second argument must be a list of numbers or a dict of series".to_string())?;
                Ok((labels, vec![("value".into(), values)], title))
            }
        }
    }

    /// Parse arguments for plot_pie.
    /// Supported forms:
    ///   ({"name": value, ...}, title?)
    ///   ([(name, value), ...], title?)
    fn parse_pie_args(
        &self,
        args: &[MontyObject],
    ) -> Result<(Vec<(String, f64)>, Option<String>), String> {
        if args.is_empty() {
            return Err("plot_pie requires at least 1 argument: a dict or list of (name, value) pairs".into());
        }

        let title = self.extract_title_from_args(args, 1);

        match &args[0] {
            MontyObject::Dict(pairs) => {
                let mut data = Vec::new();
                for (k, v) in pairs {
                    let name = match k {
                        MontyObject::String(s) => s.clone(),
                        other => format!("{other}"),
                    };
                    let value = self.monty_to_f64(v)
                        .ok_or_else(|| format!("Value for '{name}' must be a number"))?;
                    data.push((name, value));
                }
                Ok((data, title))
            }
            MontyObject::List(items) => {
                let mut data = Vec::new();
                for item in items {
                    match item {
                        MontyObject::Tuple(pair) if pair.len() == 2 => {
                            let name = match &pair[0] {
                                MontyObject::String(s) => s.clone(),
                                other => format!("{other}"),
                            };
                            let value = self.monty_to_f64(&pair[1])
                                .ok_or_else(|| format!("Value for '{name}' must be a number"))?;
                            data.push((name, value));
                        }
                        MontyObject::List(pair) if pair.len() == 2 => {
                            let name = match &pair[0] {
                                MontyObject::String(s) => s.clone(),
                                other => format!("{other}"),
                            };
                            let value = self.monty_to_f64(&pair[1])
                                .ok_or_else(|| format!("Value for '{name}' must be a number"))?;
                            data.push((name, value));
                        }
                        _ => return Err("Each item must be a (name, value) tuple".into()),
                    }
                }
                Ok((data, title))
            }
            _ => Err("plot_pie requires a dict {name: value, ...} or list of (name, value) pairs".into()),
        }
    }

    // -- Chart helper methods --

    fn extract_title_from_args(&self, args: &[MontyObject], idx: usize) -> Option<String> {
        args.get(idx).and_then(|a| match a {
            MontyObject::String(s) => Some(s.clone()),
            _ => None,
        })
    }

    fn extract_string_list(&self, pairs: &DictPairs, key: &str) -> Result<Vec<String>, String> {
        for (k, v) in pairs {
            if let MontyObject::String(s) = k {
                if s == key {
                    return self.monty_to_string_list(v)
                        .ok_or_else(|| format!("'{key}' must be a list of strings"));
                }
            }
        }
        Err(format!("Missing '{key}' in dict"))
    }

    fn extract_number_list(&self, pairs: &DictPairs, key: &str) -> Result<Vec<f64>, String> {
        for (k, v) in pairs {
            if let MontyObject::String(s) = k {
                if s == key {
                    return self.monty_to_number_list(v)
                        .ok_or_else(|| format!("'{key}' must be a list of numbers"));
                }
            }
        }
        Err(format!("Missing '{key}' in dict"))
    }

    fn extract_series_dict(&self, pairs: &DictPairs) -> Result<Vec<(String, Vec<f64>)>, String> {
        for (k, v) in pairs {
            if let MontyObject::String(s) = k {
                if s == "series" {
                    if let MontyObject::Dict(series_pairs) = v {
                        let mut result = Vec::new();
                        for (sk, sv) in series_pairs {
                            let name = match sk {
                                MontyObject::String(s) => s.clone(),
                                other => format!("{other}"),
                            };
                            let values = self.monty_to_number_list(sv)
                                .ok_or_else(|| format!("Series '{name}' must be a list of numbers"))?;
                            result.push((name, values));
                        }
                        return Ok(result);
                    } else {
                        return Err("'series' must be a dict of {name: [values]}".into());
                    }
                }
            }
        }
        Err("Missing 'series' in dict".into())
    }

    fn monty_to_string_list(&self, obj: &MontyObject) -> Option<Vec<String>> {
        if let MontyObject::List(items) = obj {
            items.iter().map(|item| match item {
                MontyObject::String(s) => Some(s.clone()),
                other => Some(format!("{other}")),
            }).collect()
        } else {
            None
        }
    }

    fn monty_to_number_list(&self, obj: &MontyObject) -> Option<Vec<f64>> {
        if let MontyObject::List(items) = obj {
            items.iter().map(|item| self.monty_to_f64(item)).collect()
        } else {
            None
        }
    }

    fn monty_to_f64(&self, obj: &MontyObject) -> Option<f64> {
        match obj {
            MontyObject::Int(n) => Some(*n as f64),
            MontyObject::Float(f) => Some(*f),
            MontyObject::String(s) => s.parse::<f64>().ok(),
            _ => None,
        }
    }
}

/// Check whether a DictPairs has a key with the given name.
fn dict_has_key(pairs: &DictPairs, key: &str) -> bool {
    for (k, _) in pairs {
        if let MontyObject::String(s) = k {
            if s == key {
                return true;
            }
        }
    }
    false
}

/// Format a serde_json::Value to a compact display string.
fn format_json_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => "null".to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Format an ISO timestamp to a shorter display string.
/// If it's today, show just the time. Otherwise show date + time.
fn format_timestamp(ts: &str) -> String {
    // Extract just the time portion (HH:MM:SS) from ISO format.
    if let Some(t_pos) = ts.find('T') {
        let time_part = &ts[t_pos + 1..];
        // Take HH:MM:SS, drop fractional seconds and timezone.
        let short_time: String = time_part.chars().take(8).collect();
        return short_time;
    }
    ts.to_string()
}

/// Combine prefix output with new output, avoiding empty concatenation.
fn combine_output(prefix: &str, new: &str) -> String {
    if prefix.is_empty() {
        new.to_string()
    } else if new.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}{new}")
    }
}

/// Parse an ago() argument like "6h", "30m", "2d" and return a MontyObject::Int
/// representing the number of hours (for use with history/statistics).
///
/// Supported suffixes: m (minutes), h (hours), d (days), w (weeks).
/// Returns the value in hours (rounded). Falls back to 6 for unparseable input.
fn parse_ago_to_monty(args: &[monty::MontyObject]) -> monty::MontyObject {
    let input = match args.first() {
        Some(monty::MontyObject::String(s)) => s.clone(),
        Some(monty::MontyObject::Int(n)) => return monty::MontyObject::Int(*n),
        Some(monty::MontyObject::Float(f)) => return monty::MontyObject::Int(*f as i64),
        _ => return monty::MontyObject::Int(6),
    };

    let trimmed = input.trim().to_lowercase();
    if trimmed.is_empty() {
        return monty::MontyObject::Int(6);
    }

    // Try to parse as number + suffix.
    let (num_str, suffix) = if trimmed.chars().last().map(|c| c.is_alphabetic()).unwrap_or(false) {
        let split = trimmed.len() - 1;
        (&trimmed[..split], &trimmed[split..])
    } else {
        (trimmed.as_str(), "h") // default to hours
    };

    let num: f64 = match num_str.parse() {
        Ok(n) => n,
        Err(_) => return monty::MontyObject::Int(6),
    };

    let hours = match suffix {
        "m" => (num / 60.0).max(1.0),
        "h" => num,
        "d" => num * 24.0,
        "w" => num * 168.0,
        _ => num, // assume hours
    };

    monty::MontyObject::Int(hours.round() as i64)
}

/// Map a state string to a timeline segment color.
fn state_to_timeline_color(state: &str) -> String {
    match state {
        "on" | "home" | "open" | "playing" | "active" => "#44b556".to_string(),
        "off" | "not_home" | "closed" | "idle" | "paused" | "standby" => "#969696".to_string(),
        "unavailable" => "#c74848".to_string(),
        "unknown" => "#606060".to_string(),
        _ => "#2196f3".to_string(),
    }
}

/// Parse an ISO 8601 timestamp string to milliseconds since epoch.
/// Handles common formats: "2026-02-15T10:30:00Z", "2026-02-15T10:30:00+00:00",
/// "2026-02-15T10:30:00.123Z", etc.
fn parse_iso_to_ms(ts: &str) -> Option<f64> {
    // Simplified parser — extract year, month, day, hour, min, sec.
    // For a proper implementation we'd use chrono, but we keep deps minimal.
    let t_pos = ts.find('T')?;
    let date_part = &ts[..t_pos];
    let time_part = &ts[t_pos + 1..];

    let date_parts: Vec<&str> = date_part.split('-').collect();
    if date_parts.len() != 3 {
        return None;
    }
    let year: i64 = date_parts[0].parse().ok()?;
    let month: i64 = date_parts[1].parse().ok()?;
    let day: i64 = date_parts[2].parse().ok()?;

    // Strip timezone suffix for time parsing.
    let time_clean = time_part
        .trim_end_matches('Z')
        .split('+').next()?
        .split('-').next()?;
    let time_parts: Vec<&str> = time_clean.split(':').collect();
    if time_parts.len() < 2 {
        return None;
    }
    let hour: i64 = time_parts[0].parse().ok()?;
    let min: i64 = time_parts[1].parse().ok()?;
    // Seconds may have fractional part.
    let sec: f64 = time_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);

    // Simplified days-since-epoch calculation (good enough for relative comparisons).
    // This doesn't account for all leap year edge cases perfectly but works for
    // recent dates and relative comparisons within a few years.
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let month_days = [31, if is_leap_year(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 0..(month - 1) as usize {
        days += month_days[m] as i64;
    }
    days += day - 1;

    let total_secs = (days * 86400) + (hour * 3600) + (min * 60) + sec as i64;
    let frac_ms = (sec.fract() * 1000.0).round();
    Some((total_secs as f64) * 1000.0 + frac_ms)
}

/// Check if a year is a leap year.
fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Known HA domains for auto-resolve.
const HA_DOMAINS: &[&str] = &[
    "alarm_control_panel", "automation", "binary_sensor", "button", "calendar",
    "camera", "climate", "counter", "cover", "device_tracker", "fan", "group",
    "humidifier", "image", "input_boolean", "input_datetime", "input_number",
    "input_select", "input_text", "light", "lock", "media_player", "notify",
    "number", "person", "remote", "scene", "script", "select", "sensor",
    "siren", "sun", "switch", "timer", "todo", "tts", "update", "vacuum",
    "water_heater", "weather", "zone",
];

/// Check if input looks like an entity_id (domain.object_id).
fn looks_like_entity_id(input: &str) -> bool {
    if let Some(dot_pos) = input.find('.') {
        let domain = &input[..dot_pos];
        let object_id = &input[dot_pos + 1..];
        // Must have both parts, only alphanumeric + underscore.
        !domain.is_empty()
            && !object_id.is_empty()
            && HA_DOMAINS.contains(&domain)
            && object_id.chars().all(|c| c.is_alphanumeric() || c == '_')
    } else {
        false
    }
}

/// Check if input is a bare HA domain name.
fn looks_like_domain(input: &str) -> bool {
    HA_DOMAINS.contains(&input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_input() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"text""#));
    }

    #[test]
    fn test_help_command() {
        let mut engine = ShellEngine::new();
        let result = engine.eval(":help");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"help""#));
        assert!(json.contains("Signal Deck"));
    }

    #[test]
    fn test_clear_command() {
        let mut engine = ShellEngine::new();
        let result = engine.eval(":clear");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("[clear]"));
    }

    #[test]
    fn test_ls_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("%ls binary_sensor");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#));
        assert!(json.contains(r#""method":"get_states""#));
        assert!(json.contains("binary_sensor"));
    }

    #[test]
    fn test_get_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("%get sensor.temp");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""method":"get_state""#));
        assert!(json.contains("sensor.temp"));
    }

    #[test]
    fn test_attrs_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("%attrs sensor.temp");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""method":"get_state""#));
        assert!(json.contains("attrs_only"));
    }

    #[test]
    fn test_diff_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("%diff sensor.temp sensor.humidity");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""method":"get_diff""#));
        assert!(json.contains("entity_a"));
        assert!(json.contains("entity_b"));
    }

    #[test]
    fn test_python_arithmetic() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("2 + 3");
        let json = serde_json::to_string(&result).unwrap();
        // Should execute via Monty and return result.
        assert!(json.contains("5"), "Expected 5 in: {json}");
    }

    #[test]
    fn test_python_print() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("print('hello from monty')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("hello from monty"), "Expected print output in: {json}");
    }

    #[test]
    fn test_python_dict_subscript() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("d = {\"a\": 1, \"b\": 2}\nd[\"a\"]");
        let json = serde_json::to_string(&result).unwrap();
        eprintln!("dict subscript result: {json}");
        assert!(json.contains("1"), "Expected 1 in: {json}");
    }

    #[test]
    fn test_python_list_of_lists_subscript() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("data = [[1, 2], [3, 4]]\ndata[0]");
        let json = serde_json::to_string(&result).unwrap();
        eprintln!("list subscript result: {json}");
        assert!(json.contains("1") && json.contains("2"), "Expected [1,2] in: {json}");
    }

    #[test]
    fn test_plot_series_simple() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("plot_series([(1, 10), (2, 20), (3, 15)], \"Test\")");
        let json = serde_json::to_string(&result).unwrap();
        eprintln!("plot_series result: {json}");
        assert!(json.contains("echarts"), "Expected echarts in: {json}");
    }

    #[test]
    fn test_plot_series_after_assignment() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("data = [(1, 10), (2, 20)]\nplot_series(data, \"Test\")");
        let json = serde_json::to_string(&result).unwrap();
        eprintln!("plot_series after assignment: {json}");
        assert!(json.contains("echarts"), "Expected echarts in: {json}");
    }

    #[test]
    fn test_plot_series_dict_form() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("plot_series({\"A\": [(1, 10), (2, 20)]}, \"Test\")");
        let json = serde_json::to_string(&result).unwrap();
        eprintln!("plot_series dict form: {json}");
        assert!(json.contains("echarts"), "Expected echarts in: {json}");
    }

    #[test]
    fn test_python_syntax_error() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("def f(:");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"error""#), "Expected error in: {json}");
    }

    #[test]
    fn test_python_state_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("state('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#), "Expected host_call in: {json}");
        assert!(json.contains(r#""method":"get_state""#), "Expected get_state method in: {json}");
        assert!(json.contains("sensor.temp"), "Expected entity_id in: {json}");
    }

    #[test]
    fn test_python_states_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("states('light')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#), "Expected host_call in: {json}");
        assert!(json.contains(r#""method":"get_states""#), "Expected get_states method in: {json}");
    }

    #[test]
    fn test_python_state_resume() {
        let mut engine = ShellEngine::new();
        // Start a Python snippet that calls state().
        let result = engine.eval("state('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#));

        // Extract the call_id.
        let spec: serde_json::Value = serde_json::from_str(&json).unwrap();
        let call_id = spec["call_id"].as_str().unwrap();

        // Fulfill with state data — the Monty execution should resume and return the value.
        let state_data = r#"{"entity_id": "sensor.temp", "state": "22.5"}"#;
        let result = engine.fulfill_host_call(call_id, state_data);
        let json = serde_json::to_string(&result).unwrap();
        // Should contain the returned dict value.
        assert!(!json.contains(r#""type":"error""#), "Unexpected error in: {json}");
    }

    #[test]
    fn test_auto_resolve_entity_id() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("sensor.temp");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""method":"get_state""#));
        assert!(json.contains("sensor.temp"));
    }

    #[test]
    fn test_auto_resolve_domain() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("light");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""method":"get_states""#));
        assert!(json.contains(r#""domain":"light""#));
    }

    #[test]
    fn test_auto_resolve_not_random_word() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("foobar");
        let json = serde_json::to_string(&result).unwrap();
        // Should be treated as Python, not auto-resolved.
        // Monty will try to run it as Python (likely a NameError).
        assert!(!json.contains(r#""method":"get_state""#), "Should not auto-resolve: {json}");
        assert!(!json.contains(r#""method":"get_states""#), "Should not auto-resolve: {json}");
    }

    #[test]
    fn test_history_recorded() {
        let mut engine = ShellEngine::new();
        engine.eval("%ls");
        engine.eval("state('x')");
        assert_eq!(engine.session.history().len(), 2);
    }

    #[test]
    fn test_prompt() {
        let engine = ShellEngine::new();
        assert_eq!(engine.prompt(), "≫ ");
    }

    #[test]
    fn test_fulfill_state_list_with_summary() {
        let mut engine = ShellEngine::new();
        let data = r#"[
            {"entity_id": "sensor.temp", "state": "22.5", "last_changed": "2026-02-15T10:00:00Z", "attributes": {"device_class": "temperature", "unit_of_measurement": "°C"}},
            {"entity_id": "sensor.humidity", "state": "45", "last_changed": "2026-02-15T10:00:00Z", "attributes": {"device_class": "humidity", "unit_of_measurement": "%"}}
        ]"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        // Should be a vstack with summary + table.
        assert!(json.contains(r#""type":"vstack""#));
        assert!(json.contains(r#""type":"summary""#));
        assert!(json.contains(r#""type":"table""#));
        assert!(json.contains("2 entities"));
        assert!(json.contains("sensor: 2"));
        // Units should be appended.
        assert!(json.contains("22.5 °C"));
        assert!(json.contains("45 %"));
    }

    #[test]
    fn test_fulfill_state_list_with_binary_sensors() {
        let mut engine = ShellEngine::new();
        let data = r#"[
            {"entity_id": "binary_sensor.front_door", "state": "off", "last_changed": "2026-02-15T09:30:00Z", "attributes": {"device_class": "door"}},
            {"entity_id": "binary_sensor.motion", "state": "on", "last_changed": "2026-02-15T09:45:00Z", "attributes": {"device_class": "motion"}}
        ]"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("󰷚")); // closed door icon
        assert!(json.contains("○"));  // off indicator
        assert!(json.contains("󰒲")); // motion detected icon
        assert!(json.contains("●"));  // on indicator
    }

    #[test]
    fn test_fulfill_single_state_entity_card() {
        let mut engine = ShellEngine::new();
        let data = r#"{"entity_id": "sensor.temp", "state": "22.5", "last_changed": "2026-02-15T10:30:00Z", "attributes": {"unit_of_measurement": "°C", "device_class": "temperature", "friendly_name": "Living Room Temperature"}}"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"entity_card""#));
        assert!(json.contains("sensor.temp"));
        assert!(json.contains("22.5"));
        assert!(json.contains("󰔏")); // temperature icon
        assert!(json.contains("Living Room Temperature"));
        assert!(json.contains("accent")); // state color for numeric
        assert!(json.contains("°C"));
        assert!(json.contains("temperature")); // device_class
    }

    #[test]
    fn test_fulfill_attrs_only() {
        let mut engine = ShellEngine::new();
        let data = r#"{"__attrs_only": true, "entity": {"entity_id": "sensor.temp", "state": "22.5", "attributes": {"device_class": "temperature", "unit_of_measurement": "°C"}}}"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"key_value""#));
        assert!(json.contains("sensor.temp"));
        assert!(json.contains("device_class"));
        assert!(json.contains("temperature"));
    }

    #[test]
    fn test_fulfill_diff() {
        let mut engine = ShellEngine::new();
        let data = r#"{"__diff": true, "entity_a": {"entity_id": "sensor.temp", "state": "22.5", "attributes": {"device_class": "temperature", "unit_of_measurement": "°C"}}, "entity_b": {"entity_id": "sensor.humidity", "state": "45", "attributes": {"device_class": "humidity", "unit_of_measurement": "%"}}}"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"vstack""#));
        assert!(json.contains("Comparing"));
        assert!(json.contains("sensor.temp"));
        assert!(json.contains("sensor.humidity"));
        assert!(json.contains("device_class"));
    }

    #[test]
    fn test_format_timestamp() {
        assert_eq!(format_timestamp("2026-02-15T10:30:45.123Z"), "10:30:45");
        assert_eq!(format_timestamp("2026-02-15T09:00:00+00:00"), "09:00:00");
        assert_eq!(format_timestamp("not-a-timestamp"), "not-a-timestamp");
    }

    #[test]
    fn test_parse_ago_hours() {
        let args = vec![monty::MontyObject::String("6h".into())];
        match parse_ago_to_monty(&args) {
            monty::MontyObject::Int(n) => assert_eq!(n, 6),
            other => panic!("Expected Int, got: {other:?}"),
        }
    }

    #[test]
    fn test_parse_ago_minutes() {
        let args = vec![monty::MontyObject::String("30m".into())];
        match parse_ago_to_monty(&args) {
            monty::MontyObject::Int(n) => assert_eq!(n, 1), // 30m → 1h (rounded, min 1)
            other => panic!("Expected Int, got: {other:?}"),
        }
    }

    #[test]
    fn test_parse_ago_days() {
        let args = vec![monty::MontyObject::String("2d".into())];
        match parse_ago_to_monty(&args) {
            monty::MontyObject::Int(n) => assert_eq!(n, 48),
            other => panic!("Expected Int, got: {other:?}"),
        }
    }

    #[test]
    fn test_parse_ago_weeks() {
        let args = vec![monty::MontyObject::String("1w".into())];
        match parse_ago_to_monty(&args) {
            monty::MontyObject::Int(n) => assert_eq!(n, 168),
            other => panic!("Expected Int, got: {other:?}"),
        }
    }

    #[test]
    fn test_parse_ago_bare_number() {
        let args = vec![monty::MontyObject::String("12".into())];
        match parse_ago_to_monty(&args) {
            monty::MontyObject::Int(n) => assert_eq!(n, 12), // defaults to hours
            other => panic!("Expected Int, got: {other:?}"),
        }
    }

    #[test]
    fn test_parse_ago_int_passthrough() {
        let args = vec![monty::MontyObject::Int(24)];
        match parse_ago_to_monty(&args) {
            monty::MontyObject::Int(n) => assert_eq!(n, 24),
            other => panic!("Expected Int, got: {other:?}"),
        }
    }

    #[test]
    fn test_python_statistics_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("statistics('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#), "Expected host_call: {json}");
        assert!(json.contains(r#""method":"get_statistics""#), "Expected get_statistics: {json}");
        assert!(json.contains("sensor.temp"), "Expected entity_id: {json}");
    }

    #[test]
    fn test_state_to_timeline_color() {
        assert_eq!(state_to_timeline_color("on"), "#44b556");
        assert_eq!(state_to_timeline_color("off"), "#969696");
        assert_eq!(state_to_timeline_color("unavailable"), "#c74848");
        assert_eq!(state_to_timeline_color("unknown"), "#606060");
        assert_eq!(state_to_timeline_color("22.5"), "#2196f3");
    }

    #[test]
    fn test_parse_iso_to_ms() {
        let ms = parse_iso_to_ms("2026-02-15T10:30:00Z");
        assert!(ms.is_some(), "Should parse ISO timestamp");
        let ms = ms.unwrap();
        assert!(ms > 0.0, "Should be positive");
    }

    #[test]
    fn test_parse_iso_to_ms_with_fraction() {
        let ms1 = parse_iso_to_ms("2026-02-15T10:30:00Z").unwrap();
        let ms2 = parse_iso_to_ms("2026-02-15T10:30:00.500Z").unwrap();
        assert!((ms2 - ms1 - 500.0).abs() < 1.0, "Fractional seconds: {} vs {}", ms1, ms2);
    }

    #[test]
    fn test_fulfill_history_numeric_sparkline() {
        let mut engine = ShellEngine::new();
        let data = r#"[[
            {"entity_id": "sensor.temp", "state": "20.0", "last_changed": "2026-02-15T08:00:00Z", "attributes": {"unit_of_measurement": "°C"}},
            {"entity_id": "sensor.temp", "state": "21.5", "last_changed": "2026-02-15T09:00:00Z"},
            {"entity_id": "sensor.temp", "state": "22.0", "last_changed": "2026-02-15T10:00:00Z"}
        ]]"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"sparkline""#), "Expected sparkline: {json}");
        assert!(json.contains("sensor.temp"), "Expected entity_id: {json}");
        assert!(json.contains("°C"), "Expected unit: {json}");
    }

    #[test]
    fn test_fulfill_history_binary_timeline() {
        let mut engine = ShellEngine::new();
        let data = r#"[[
            {"entity_id": "binary_sensor.door", "state": "off", "last_changed": "2026-02-15T08:00:00Z", "attributes": {"friendly_name": "Front Door"}},
            {"entity_id": "binary_sensor.door", "state": "on", "last_changed": "2026-02-15T09:00:00Z"},
            {"entity_id": "binary_sensor.door", "state": "off", "last_changed": "2026-02-15T10:00:00Z"}
        ]]"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"timeline""#), "Expected timeline: {json}");
        assert!(json.contains("binary_sensor.door"), "Expected entity_id: {json}");
        assert!(json.contains("#44b556"), "Expected on color: {json}");
        assert!(json.contains("#969696"), "Expected off color: {json}");
    }

    #[test]
    fn test_fulfill_statistics_sparkline() {
        let mut engine = ShellEngine::new();
        let data = r#"{"sensor.temp": [
            {"start": 1739600000, "end": 1739603600, "mean": 20.0, "min": 19.5, "max": 20.5},
            {"start": 1739603600, "end": 1739607200, "mean": 21.0, "min": 20.5, "max": 21.5},
            {"start": 1739607200, "end": 1739610800, "mean": 22.0, "min": 21.5, "max": 22.5}
        ]}"#;
        let result = engine.fulfill_host_call("call_1", data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"sparkline""#), "Expected sparkline: {json}");
        assert!(json.contains("sensor.temp"), "Expected entity_id: {json}");
    }

    #[test]
    fn test_looks_like_entity_id() {
        assert!(looks_like_entity_id("sensor.temp"));
        assert!(looks_like_entity_id("binary_sensor.front_door"));
        assert!(!looks_like_entity_id("foobar.thing"));
        assert!(!looks_like_entity_id("sensor"));
        assert!(!looks_like_entity_id("hello world"));
    }

    #[test]
    fn test_looks_like_domain() {
        assert!(looks_like_domain("sensor"));
        assert!(looks_like_domain("light"));
        assert!(looks_like_domain("binary_sensor"));
        assert!(!looks_like_domain("foobar"));
        assert!(!looks_like_domain("sensor.temp"));
    }

    // ── Python context persistence tests ──────────────────────────────

    #[test]
    fn test_python_variable_persists() {
        let mut engine = ShellEngine::new();
        // Define a variable.
        let r1 = engine.eval("x = 42");
        let j1 = serde_json::to_string(&r1).unwrap();
        assert!(!j1.contains(r#""type":"error""#), "Assign should succeed: {j1}");

        // Read it back.
        let r2 = engine.eval("print(x)");
        let j2 = serde_json::to_string(&r2).unwrap();
        assert!(j2.contains("42"), "Variable x should persist: {j2}");
    }

    #[test]
    fn test_python_function_persists() {
        let mut engine = ShellEngine::new();
        engine.eval("def greet(name):\n    return f'hello {name}'");
        let result = engine.eval("greet('world')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("hello world"), "Function should persist: {json}");
    }

    #[test]
    fn test_python_error_does_not_corrupt_context() {
        let mut engine = ShellEngine::new();
        // Successful assignment.
        engine.eval("x = 10");
        // Error — should not be committed.
        let err = engine.eval("y = 1/0");
        let j_err = serde_json::to_string(&err).unwrap();
        assert!(j_err.contains(r#""type":"error""#), "Division by zero: {j_err}");
        // x should still be accessible.
        let r = engine.eval("print(x)");
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("10"), "x should survive after error: {j}");
    }

    #[test]
    fn test_python_multi_step_accumulation() {
        let mut engine = ShellEngine::new();
        engine.eval("a = 1");
        engine.eval("b = 2");
        engine.eval("c = a + b");
        let result = engine.eval("print(c)");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("3"), "Multi-step accumulation: {json}");
    }

    #[test]
    fn test_python_context_prefix_print_stripped() {
        let mut engine = ShellEngine::new();
        // First command prints something.
        engine.eval("print('setup')");
        // Second command prints something else — should NOT re-show 'setup'.
        let result = engine.eval("print('result')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("result"), "Should contain new output: {json}");
        assert!(!json.contains("setup"), "Should NOT re-show context output: {json}");
    }

    #[test]
    fn test_python_state_does_not_commit_to_context() {
        let mut engine = ShellEngine::new();
        // Start a host call.
        let result = engine.eval("s = state('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#));

        let spec: serde_json::Value = serde_json::from_str(&json).unwrap();
        let call_id = spec["call_id"].as_str().unwrap();

        // Fulfill it.
        let state_data = r#"{"entity_id": "sensor.temp", "state": "22.5"}"#;
        engine.fulfill_host_call(call_id, state_data);

        // 's' should NOT be accessible — ext-fn snippets aren't committed
        // to context because they can't be safely replayed.
        let r2 = engine.eval("print(type(s))");
        let j2 = serde_json::to_string(&r2).unwrap();
        assert!(j2.contains(r#""type":"error""#), "s should NOT persist: {j2}");
    }

    #[test]
    fn test_standalone_state_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("state('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#), "Expected host_call in: {json}");
        assert!(json.contains(r#""method":"get_state""#), "Expected get_state in: {json}");
    }

    #[test]
    fn test_standalone_states_produces_host_call() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("states('light')");
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""type":"host_call""#), "Expected host_call in: {json}");
        assert!(json.contains(r#""method":"get_states""#), "Expected get_states in: {json}");
    }

    // ── EntityState dataclass integration tests ──────────────────────

    #[test]
    fn test_state_resume_returns_entity_card() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("state('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        let spec: serde_json::Value = serde_json::from_str(&json).unwrap();
        let call_id = spec["call_id"].as_str().unwrap();

        let state_data = r#"{"entity_id": "sensor.temp", "state": "22.5", "attributes": {"unit_of_measurement": "°C", "friendly_name": "Temp"}}"#;
        let result = engine.fulfill_host_call(call_id, state_data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains(r#""type":"error""#), "Unexpected error: {json}");
        // Should render as a rich entity card (auto-display for EntityState).
        assert!(json.contains(r#""type":"entity_card""#), "Expected entity_card: {json}");
        assert!(json.contains("sensor.temp"), "Expected entity_id: {json}");
        assert!(json.contains("22.5"), "Expected state value: {json}");
    }

    #[test]
    fn test_state_entity_id_accessible() {
        // Verify that e.entity_id works on the returned EntityState.
        let mut engine = ShellEngine::new();
        let result = engine.eval("e = state('sensor.temp')");
        let json = serde_json::to_string(&result).unwrap();
        let spec: serde_json::Value = serde_json::from_str(&json).unwrap();
        let call_id = spec["call_id"].as_str().unwrap();

        let state_data = r#"{"entity_id": "sensor.temp", "state": "22.5", "attributes": {}}"#;
        let _result = engine.fulfill_host_call(call_id, state_data);

        // Note: ext-fn snippets are NOT committed to context (can't be replayed).
        // So `e` won't be accessible. This test verifies that the dataclass
        // at least doesn't cause an error during resume.
    }

    #[test]
    fn test_states_resume_returns_table() {
        let mut engine = ShellEngine::new();
        let result = engine.eval("states('sensor')");
        let json = serde_json::to_string(&result).unwrap();
        let spec: serde_json::Value = serde_json::from_str(&json).unwrap();
        let call_id = spec["call_id"].as_str().unwrap();

        let states_data = r#"[
            {"entity_id": "sensor.a", "state": "1", "attributes": {}},
            {"entity_id": "sensor.b", "state": "2", "attributes": {}}
        ]"#;
        let result = engine.fulfill_host_call(call_id, states_data);
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains(r#""type":"error""#), "Unexpected error: {json}");
        // Should render as a table with summary (auto-display for list of EntityState).
        assert!(json.contains(r#""type":"vstack""#), "Expected vstack: {json}");
        assert!(json.contains(r#""type":"summary""#), "Expected summary: {json}");
        assert!(json.contains(r#""type":"table""#), "Expected table: {json}");
        assert!(json.contains("2 entities"), "Expected entity count: {json}");
    }
}
