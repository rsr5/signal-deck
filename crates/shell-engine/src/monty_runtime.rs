//! Monty Python runtime — REPL lifecycle, host call mapping, and data conversion.
//!
//! This module wraps Monty's `MontyRepl` to provide a stateful REPL that
//! persists variables across snippets without replaying previous code.
//!
//! ## Two execution paths
//!
//! - **`feed()`** borrows `&mut self`.  The REPL is never consumed, so it
//!   survives even on runtime errors.  Returns expression values directly.
//!   Cannot handle external function calls (they require VM suspension).
//!
//! - **`start()`** consumes `self` and returns `ReplProgress`, which can
//!   suspend at external calls (`FunctionCall`) or report runtime errors
//!   (`Error`) — both variants return the REPL so session state is
//!   preserved.  `Err(MontyException)` is only returned for syntax/compile
//!   errors (before execution starts).
//!
//! The engine tries `feed()` first.  If the snippet calls an external
//! function, `feed()` returns a "not implemented" error — the engine
//! then retries with `start()`.

use monty::{
    ExternalResult, MontyException, MontyObject, MontyRepl, NoLimitTracker, PrintWriter,
    ReplProgress, ReplSnapshot,
};

// ---------------------------------------------------------------------------
// External function registry
// ---------------------------------------------------------------------------

/// Names of all external functions available to user Python code.
///
/// These are registered with Monty at REPL init time. When user code calls
/// one of these, Monty suspends execution and returns a `ReplProgress::FunctionCall`.
pub const HA_EXTERNAL_FUNCTIONS: &[&str] = &[
    // State — short aliases (user-facing API)
    "state",
    "states",
    // State — long names
    "get_state",
    "get_states",
    // History & statistics — short aliases
    "history",
    "statistics",
    // History & statistics — long names
    "get_history",
    "get_statistics",
    // Services
    "call_service",
    "get_services",
    // Areas
    "get_areas",
    "get_area_entities",
    // Time
    "ago",
    "get_datetime",
    // Display
    "show",
    // Logbook
    "get_logbook",
    // Traces
    "get_trace",
    "list_traces",
    // Charting
    "plot_line",
    "plot_bar",
    "plot_pie",
    "plot_series",
];

// ---------------------------------------------------------------------------
// REPL lifecycle
// ---------------------------------------------------------------------------

/// Outcome of a REPL snippet evaluation or snapshot resume.
pub enum ReplEvalResult {
    /// Snippet completed — value and captured print output.
    /// The REPL is returned so it can be stored back in the session.
    Complete {
        repl: MontyRepl<NoLimitTracker>,
        output: String,
        value: Option<MontyObject>,
    },
    /// Snippet suspended at an external function call.
    HostCallNeeded {
        output: String,
        function_name: String,
        args: Vec<MontyObject>,
        snapshot: ReplSnapshot<NoLimitTracker>,
    },
    /// Snippet failed with an error.
    /// The REPL is always returned — runtime errors preserve session state
    /// via `ReplProgress::Error`.  `repl: None` only occurs on syntax/compile
    /// errors during `start()` (before execution began).
    Error {
        message: String,
        repl: Option<MontyRepl<NoLimitTracker>>,
    },
}

/// Initialise a fresh Monty REPL session.
///
/// The `init_code` is compiled and executed once to set up the REPL state.
/// Pass an empty string for a blank session.
pub fn init_repl(init_code: &str) -> Result<MontyRepl<NoLimitTracker>, String> {
    let ext_fn_names: Vec<String> = HA_EXTERNAL_FUNCTIONS.iter().map(|s| s.to_string()).collect();
    let mut print = PrintWriter::Collect(String::new());
    let (repl, _init_value) = MontyRepl::new(
        init_code.to_owned(),
        "<signal-deck>",
        vec![],          // no input names
        ext_fn_names,
        vec![],          // no input values
        NoLimitTracker,
        &mut print,
    )
    .map_err(|e| format_monty_error(&e))?;
    Ok(repl)
}

/// Execute a snippet using `feed()` — borrows the REPL.
///
/// `feed()` takes `&mut self` so the REPL is **never lost**, even on
/// runtime errors.  It returns the expression value directly.
///
/// The one thing `feed()` cannot do is handle external function calls.
/// If the snippet calls `state()`, `show()`, etc., `feed()` returns an
/// error containing "not implemented with standard execution".  The
/// caller should detect this and retry with `start_snippet()`.
pub fn feed_snippet(
    repl: &mut MontyRepl<NoLimitTracker>,
    code: &str,
) -> Result<(String, Option<MontyObject>), String> {
    let mut print = PrintWriter::Collect(String::new());
    let value = repl.feed(code, &mut print).map_err(|e| format_monty_error(&e))?;
    let output = print.collected_output().unwrap_or("").to_owned();
    let val = if value == MontyObject::None {
        None
    } else {
        Some(value)
    };
    Ok((output, val))
}

/// Execute a snippet using `start()` — consumes the REPL.
///
/// Required when the snippet calls external functions (`state()`, `show()`,
/// etc.), because only `start()` can suspend at those calls.
///
/// With the exceptions branch, `start()` returns `ReplProgress::Error`
/// (with the REPL preserved) on runtime errors.  `Err(MontyException)` is
/// only returned for syntax/compile errors before execution begins — in
/// that case the REPL is consumed and must be re-created.
pub fn start_snippet(repl: MontyRepl<NoLimitTracker>, code: &str) -> ReplEvalResult {
    let mut print = PrintWriter::Collect(String::new());
    let progress = repl.start(code, &mut print);
    let output = print.collected_output().unwrap_or("").to_owned();
    match progress {
        Ok(prog) => finish_repl_progress(prog, output),
        Err(e) => {
            // Syntax/compile error — REPL was consumed, snippet never ran.
            ReplEvalResult::Error {
                message: format_monty_error(&e),
                repl: None,
            }
        }
    }
}

/// Resume a suspended REPL execution with an external result.
pub fn resume_snapshot(
    snapshot: ReplSnapshot<NoLimitTracker>,
    result: ExternalResult,
) -> ReplEvalResult {
    let mut print = PrintWriter::Collect(String::new());
    let progress = snapshot.run(result, &mut print);
    let output = print.collected_output().unwrap_or("").to_owned();
    match progress {
        Ok(prog) => finish_repl_progress(prog, output),
        Err(e) => {
            // Should not happen with the exceptions branch — runtime errors
            // come back as ReplProgress::Error.  But handle defensively.
            ReplEvalResult::Error {
                message: format_monty_error(&e),
                repl: None,
            }
        }
    }
}

/// Convert a `ReplProgress` into our `ReplEvalResult`.
fn finish_repl_progress(
    progress: ReplProgress<NoLimitTracker>,
    output: String,
) -> ReplEvalResult {
    match progress {
        ReplProgress::Complete { repl, value } => {
            let val = if value == MontyObject::None {
                None
            } else {
                Some(value)
            };
            ReplEvalResult::Complete { repl, output, value: val }
        }
        ReplProgress::FunctionCall {
            function_name,
            args,
            state,
            ..
        } => ReplEvalResult::HostCallNeeded {
            output,
            function_name,
            args,
            snapshot: state,
        },
        ReplProgress::Error { repl, error } => ReplEvalResult::Error {
            message: format_monty_error(&error),
            repl: Some(repl),
        },
        ReplProgress::OsCall { .. } => ReplEvalResult::Error {
            message: "OS calls are not supported in Signal Deck.".to_string(),
            repl: None,
        },
        ReplProgress::ResolveFutures(_) => ReplEvalResult::Error {
            message: "Async futures are not supported in Signal Deck.".to_string(),
            repl: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Host call mapping
// ---------------------------------------------------------------------------

/// Map an external function call from Monty to a host call method + params.
///
/// Returns `None` for functions that are handled locally (show, ago, charts).
pub fn map_ext_call_to_host_call(
    function_name: &str,
    args: &[MontyObject],
) -> Option<(&'static str, serde_json::Value)> {
    match function_name {
        "state" | "get_state" => {
            let entity_id = args.first().and_then(|a| {
                if let MontyObject::String(s) = a {
                    Some(s.as_str())
                } else {
                    None
                }
            })?;
            Some(("get_state", serde_json::json!({ "entity_id": entity_id })))
        }
        "states" | "get_states" => {
            let domain = args.first().and_then(|a| {
                if let MontyObject::String(s) = a {
                    Some(s.clone())
                } else {
                    None
                }
            });
            let params = match domain {
                Some(d) => serde_json::json!({ "domain": d }),
                None => serde_json::json!({}),
            };
            Some(("get_states", params))
        }
        "history" | "get_history" => {
            let entity_id = args.first().and_then(|a| {
                if let MontyObject::String(s) = a {
                    Some(s.as_str())
                } else {
                    None
                }
            })?;
            // Second arg can be hours (int/float) or an ISO timestamp string from ago().
            match args.get(1) {
                Some(MontyObject::String(s)) => {
                    Some(("get_history", serde_json::json!({
                        "entity_id": entity_id,
                        "start_time": s,
                    })))
                }
                Some(MontyObject::Int(n)) => {
                    Some(("get_history", serde_json::json!({
                        "entity_id": entity_id,
                        "hours": *n as f64,
                    })))
                }
                Some(MontyObject::Float(f)) => {
                    Some(("get_history", serde_json::json!({
                        "entity_id": entity_id,
                        "hours": f,
                    })))
                }
                _ => {
                    Some(("get_history", serde_json::json!({
                        "entity_id": entity_id,
                        "hours": 6.0,
                    })))
                }
            }
        }
        "statistics" | "get_statistics" => {
            let entity_id = args.first().and_then(|a| {
                if let MontyObject::String(s) = a {
                    Some(s.as_str())
                } else {
                    None
                }
            })?;
            let period = args.get(1).and_then(|a| {
                if let MontyObject::String(s) = a {
                    Some(s.as_str())
                } else {
                    None
                }
            }).unwrap_or("hour");
            Some(("get_statistics", serde_json::json!({
                "entity_id": entity_id,
                "period": period,
            })))
        }
        "call_service" => {
            let domain = args.first().and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.as_str()) } else { None }
            })?;
            let service = args.get(1).and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.as_str()) } else { None }
            })?;
            let data = args.get(2).map(|a| monty_obj_to_json(a)).unwrap_or(serde_json::json!({}));
            Some(("call_service", serde_json::json!({
                "domain": domain,
                "service": service,
                "service_data": data,
            })))
        }
        "get_services" => {
            let domain = args.first().and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.clone()) } else { None }
            });
            let params = match domain {
                Some(d) => serde_json::json!({ "domain": d }),
                None => serde_json::json!({}),
            };
            Some(("get_services", params))
        }
        "get_areas" => {
            Some(("get_areas", serde_json::json!({})))
        }
        "get_area_entities" => {
            let area_id = args.first().and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.as_str()) } else { None }
            })?;
            Some(("get_area_entities", serde_json::json!({ "area_id": area_id })))
        }
        "get_datetime" => {
            Some(("get_datetime", serde_json::json!({})))
        }
        "get_logbook" => {
            let entity_id = args.first().and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.as_str()) } else { None }
            });
            let hours = args.get(1).and_then(|a| match a {
                MontyObject::Int(n) => Some(*n as f64),
                MontyObject::Float(f) => Some(*f),
                _ => None,
            }).unwrap_or(24.0);
            let mut params = serde_json::json!({ "hours": hours });
            if let Some(eid) = entity_id {
                params["entity_id"] = serde_json::json!(eid);
            }
            Some(("get_logbook", params))
        }
        "get_trace" => {
            let automation_id = args.first().and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.as_str()) } else { None }
            })?;
            let run_id = args.get(1).and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.clone()) } else { None }
            });
            let mut params = serde_json::json!({ "automation_id": automation_id });
            if let Some(rid) = run_id {
                params["run_id"] = serde_json::json!(rid);
            }
            Some(("get_trace", params))
        }
        "list_traces" => {
            let domain = args.first().and_then(|a| {
                if let MontyObject::String(s) = a { Some(s.clone()) } else { None }
            });
            let params = match domain {
                Some(d) => serde_json::json!({ "domain": d }),
                None => serde_json::json!({ "domain": "automation" }),
            };
            Some(("list_traces", params))
        }
        // show, ago, plot_* are handled locally by the engine — not host calls.
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Data conversion: MontyObject ↔ JSON
// ---------------------------------------------------------------------------

/// Convert a MontyObject to a serde_json::Value.
pub fn monty_obj_to_json(obj: &MontyObject) -> serde_json::Value {
    match obj {
        MontyObject::None => serde_json::Value::Null,
        MontyObject::Bool(b) => serde_json::Value::Bool(*b),
        MontyObject::Int(n) => serde_json::json!(n),
        MontyObject::Float(f) => serde_json::json!(f),
        MontyObject::String(s) => serde_json::Value::String(s.clone()),
        MontyObject::List(items) => {
            serde_json::Value::Array(items.iter().map(monty_obj_to_json).collect())
        }
        MontyObject::Tuple(items) => {
            serde_json::Value::Array(items.iter().map(monty_obj_to_json).collect())
        }
        MontyObject::Dict(pairs) => {
            let mut map = serde_json::Map::new();
            for (k, v) in pairs {
                let key = match k {
                    MontyObject::String(s) => s.clone(),
                    other => format!("{other}"),
                };
                map.insert(key, monty_obj_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        MontyObject::Set(items) => {
            serde_json::Value::Array(items.iter().map(monty_obj_to_json).collect())
        }
        MontyObject::FrozenSet(items) => {
            serde_json::Value::Array(items.iter().map(monty_obj_to_json).collect())
        }
        MontyObject::Bytes(b) => {
            serde_json::Value::String(format!("b\"{}\"", String::from_utf8_lossy(b)))
        }
        MontyObject::Dataclass { name, attrs, .. } => {
            let mut map = serde_json::Map::new();
            map.insert("__type__".to_string(), serde_json::json!(name));
            for (k, v) in attrs {
                let key = match k {
                    MontyObject::String(s) => s.clone(),
                    other => format!("{other}"),
                };
                map.insert(key, monty_obj_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        // Catch-all for new variants (Ellipsis, BigInt, NamedTuple, Exception, Type, etc.)
        other => serde_json::Value::String(format!("{other}")),
    }
}

/// Convert a JSON value to a MontyObject.
pub fn json_to_monty_obj(value: &serde_json::Value) -> MontyObject {
    match value {
        serde_json::Value::Null => MontyObject::None,
        serde_json::Value::Bool(b) => MontyObject::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                MontyObject::Int(i)
            } else if let Some(f) = n.as_f64() {
                MontyObject::Float(f)
            } else {
                MontyObject::None
            }
        }
        serde_json::Value::String(s) => MontyObject::String(s.clone()),
        serde_json::Value::Array(arr) => {
            MontyObject::List(arr.iter().map(json_to_monty_obj).collect())
        }
        serde_json::Value::Object(map) => {
            let pairs: Vec<(MontyObject, MontyObject)> = map
                .iter()
                .map(|(k, v)| (MontyObject::String(k.clone()), json_to_monty_obj(v)))
                .collect();
            MontyObject::Dict(pairs.into())
        }
    }
}

/// Convert a HA state JSON object to an EntityState dataclass.
pub fn json_to_entity_state(value: &serde_json::Value) -> MontyObject {
    let entity_id = value
        .get("entity_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = value
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let last_changed = value
        .get("last_changed")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let last_updated = value
        .get("last_updated")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let domain = entity_id
        .split('.')
        .next()
        .unwrap_or("")
        .to_string();

    let friendly_name = value
        .get("attributes")
        .and_then(|a| a.get("friendly_name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&entity_id)
        .to_string();

    let is_on = matches!(state.as_str(), "on" | "home" | "open" | "playing" | "active");

    let attributes = value
        .get("attributes")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let attrs_monty = json_to_monty_obj(&attributes);

    MontyObject::Dataclass {
        name: "EntityState".to_string(),
        type_id: 0,
        field_names: vec![
            "entity_id".into(),
            "state".into(),
            "domain".into(),
            "name".into(),
            "last_changed".into(),
            "last_updated".into(),
            "is_on".into(),
            "attributes".into(),
        ],
        attrs: vec![
            (MontyObject::String("entity_id".into()), MontyObject::String(entity_id)),
            (MontyObject::String("state".into()), MontyObject::String(state)),
            (MontyObject::String("domain".into()), MontyObject::String(domain)),
            (MontyObject::String("name".into()), MontyObject::String(friendly_name)),
            (MontyObject::String("last_changed".into()), MontyObject::String(last_changed)),
            (MontyObject::String("last_updated".into()), MontyObject::String(last_updated)),
            (MontyObject::String("is_on".into()), MontyObject::Bool(is_on)),
            (MontyObject::String("attributes".into()), attrs_monty),
        ].into(),
        frozen: false,
    }
}

/// Convert a JSON array of HA state objects to a list of EntityState.
pub fn json_to_entity_state_list(value: &serde_json::Value) -> MontyObject {
    match value {
        serde_json::Value::Array(arr) => {
            MontyObject::List(arr.iter().map(json_to_entity_state).collect())
        }
        _ => json_to_entity_state(value),
    }
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/// Format a MontyException into a user-friendly error string.
pub fn format_monty_error(err: &MontyException) -> String {
    // MontyException implements Display with Python-style tracebacks
    err.to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_repl_empty() {
        let repl = init_repl("");
        assert!(repl.is_ok());
    }

    #[test]
    fn test_init_repl_with_code() {
        let repl = init_repl("x = 42");
        assert!(repl.is_ok());
    }

    #[test]
    fn test_init_repl_syntax_error() {
        let result = init_repl("def");
        assert!(result.is_err());
    }

    #[test]
    fn test_start_snippet_simple_expression() {
        let repl = init_repl("").unwrap();
        let result = start_snippet(repl, "1 + 2");
        match result {
            ReplEvalResult::Complete { value, .. } => {
                assert_eq!(value, Some(MontyObject::Int(3)));
            }
            _ => panic!("Expected Complete"),
        }
    }

    #[test]
    fn test_start_snippet_print_captured() {
        let repl = init_repl("").unwrap();
        let result = start_snippet(repl, "print('hello')");
        match result {
            ReplEvalResult::Complete { output, .. } => {
                assert_eq!(output.trim(), "hello");
            }
            _ => panic!("Expected Complete"),
        }
    }

    #[test]
    fn test_start_snippet_variable_persists() {
        let repl = init_repl("").unwrap();
        // First snippet: define a variable.
        let result = start_snippet(repl, "x = 42");
        let repl = match result {
            ReplEvalResult::Complete { repl, .. } => repl,
            _ => panic!("Expected Complete"),
        };
        // Second snippet: use the variable.
        let result = start_snippet(repl, "x + 1");
        match result {
            ReplEvalResult::Complete { value, .. } => {
                assert_eq!(value, Some(MontyObject::Int(43)));
            }
            _ => panic!("Expected Complete"),
        }
    }

    #[test]
    fn test_start_snippet_external_call_suspends() {
        let repl = init_repl("").unwrap();
        let result = start_snippet(repl, "get_state('sensor.temp')");
        match result {
            ReplEvalResult::HostCallNeeded { function_name, args, .. } => {
                assert_eq!(function_name, "get_state");
                assert_eq!(args, vec![MontyObject::String("sensor.temp".to_string())]);
            }
            _ => panic!("Expected HostCallNeeded"),
        }
    }

    #[test]
    fn test_start_snippet_syntax_error() {
        let repl = init_repl("").unwrap();
        let result = start_snippet(repl, "if");
        match result {
            ReplEvalResult::Error { message, .. } => {
                assert!(!message.is_empty());
            }
            _ => panic!("Expected Error"),
        }
    }

    #[test]
    fn test_resume_snapshot_completes() {
        let repl = init_repl("").unwrap();
        let result = start_snippet(repl, "get_state('sensor.temp')");
        let snapshot = match result {
            ReplEvalResult::HostCallNeeded { snapshot, .. } => snapshot,
            _ => panic!("Expected HostCallNeeded"),
        };

        // Resume with a fake entity state value.
        let fake_value = MontyObject::String("21.5".to_string());
        let resumed = resume_snapshot(snapshot, ExternalResult::Return(fake_value));
        match resumed {
            ReplEvalResult::Complete { value, repl, .. } => {
                // The result should be the string we passed in.
                assert_eq!(value, Some(MontyObject::String("21.5".to_string())));
                // And the REPL should be recoverable.
                assert!(matches!(start_snippet(repl, "1"), ReplEvalResult::Complete { .. }));
            }
            _ => panic!("Expected Complete after resume"),
        }
    }

    #[test]
    fn test_map_ext_call_get_state() {
        let args = vec![MontyObject::String("sensor.temp".to_string())];
        let result = map_ext_call_to_host_call("get_state", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_state");
        assert_eq!(params["entity_id"], "sensor.temp");
    }

    #[test]
    fn test_map_ext_call_get_states_no_domain() {
        let args = vec![];
        let result = map_ext_call_to_host_call("get_states", &args);
        assert!(result.is_some());
        let (method, _params) = result.unwrap();
        assert_eq!(method, "get_states");
    }

    #[test]
    fn test_map_ext_call_get_states_with_domain() {
        let args = vec![MontyObject::String("light".to_string())];
        let result = map_ext_call_to_host_call("get_states", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_states");
        assert_eq!(params["domain"], "light");
    }

    #[test]
    fn test_map_ext_call_show_returns_none() {
        let args = vec![MontyObject::Int(42)];
        let result = map_ext_call_to_host_call("show", &args);
        assert!(result.is_none());
    }

    #[test]
    fn test_map_ext_call_ago_returns_none() {
        let args = vec![MontyObject::String("6h".to_string())];
        let result = map_ext_call_to_host_call("ago", &args);
        assert!(result.is_none());
    }

    #[test]
    fn test_map_ext_call_unknown_returns_none() {
        let args = vec![];
        let result = map_ext_call_to_host_call("not_a_real_function", &args);
        assert!(result.is_none());
    }

    #[test]
    fn test_monty_obj_to_json_primitives() {
        assert_eq!(monty_obj_to_json(&MontyObject::None), serde_json::Value::Null);
        assert_eq!(monty_obj_to_json(&MontyObject::Bool(true)), serde_json::json!(true));
        assert_eq!(monty_obj_to_json(&MontyObject::Int(42)), serde_json::json!(42));
        assert_eq!(
            monty_obj_to_json(&MontyObject::String("hello".into())),
            serde_json::json!("hello")
        );
    }

    #[test]
    fn test_monty_obj_to_json_list() {
        let list = MontyObject::List(vec![MontyObject::Int(1), MontyObject::Int(2)]);
        assert_eq!(monty_obj_to_json(&list), serde_json::json!([1, 2]));
    }

    #[test]
    fn test_monty_obj_to_json_dict() {
        let dict = MontyObject::Dict(vec![
            (MontyObject::String("a".into()), MontyObject::Int(1)),
            (MontyObject::String("b".into()), MontyObject::Int(2)),
        ].into());
        let json = monty_obj_to_json(&dict);
        assert_eq!(json["a"], 1);
        assert_eq!(json["b"], 2);
    }

    #[test]
    fn test_json_to_monty_obj_primitives() {
        assert_eq!(json_to_monty_obj(&serde_json::Value::Null), MontyObject::None);
        assert_eq!(json_to_monty_obj(&serde_json::json!(true)), MontyObject::Bool(true));
        assert_eq!(json_to_monty_obj(&serde_json::json!(42)), MontyObject::Int(42));
        assert_eq!(
            json_to_monty_obj(&serde_json::json!("hello")),
            MontyObject::String("hello".into())
        );
    }

    #[test]
    fn test_json_to_entity_state() {
        let json = serde_json::json!({
            "entity_id": "sensor.temp",
            "state": "21.5",
            "last_changed": "2024-01-01T00:00:00Z",
            "last_updated": "2024-01-01T00:00:00Z",
            "attributes": {
                "friendly_name": "Temperature",
                "unit_of_measurement": "°C",
            }
        });
        let result = json_to_entity_state(&json);
        if let MontyObject::Dataclass { name, .. } = &result {
            assert_eq!(name, "EntityState");
            // Verify entity_id is present via JSON conversion.
            let json = monty_obj_to_json(&result);
            assert_eq!(json["entity_id"], "sensor.temp");
        } else {
            panic!("Expected Dataclass");
        }
    }

    #[test]
    fn test_json_to_entity_state_list() {
        let json = serde_json::json!([
            {
                "entity_id": "sensor.a",
                "state": "1",
                "attributes": {}
            },
            {
                "entity_id": "sensor.b",
                "state": "2",
                "attributes": {}
            }
        ]);
        let result = json_to_entity_state_list(&json);
        if let MontyObject::List(items) = &result {
            assert_eq!(items.len(), 2);
        } else {
            panic!("Expected List");
        }
    }

    #[test]
    fn test_map_ext_call_get_history() {
        let args = vec![
            MontyObject::String("sensor.temp".to_string()),
            MontyObject::Int(12),
        ];
        let result = map_ext_call_to_host_call("get_history", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_history");
        assert_eq!(params["entity_id"], "sensor.temp");
        assert_eq!(params["hours"], 12.0);
    }

    #[test]
    fn test_map_ext_call_call_service() {
        let args = vec![
            MontyObject::String("light".to_string()),
            MontyObject::String("turn_on".to_string()),
            MontyObject::Dict(vec![
                (MontyObject::String("entity_id".into()), MontyObject::String("light.kitchen".into())),
            ].into()),
        ];
        let result = map_ext_call_to_host_call("call_service", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "call_service");
        assert_eq!(params["domain"], "light");
        assert_eq!(params["service"], "turn_on");
    }

    #[test]
    fn test_map_ext_call_get_areas() {
        let result = map_ext_call_to_host_call("get_areas", &[]);
        assert!(result.is_some());
        let (method, _) = result.unwrap();
        assert_eq!(method, "get_areas");
    }

    #[test]
    fn test_map_ext_call_get_area_entities() {
        let args = vec![MontyObject::String("kitchen".to_string())];
        let result = map_ext_call_to_host_call("get_area_entities", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_area_entities");
        assert_eq!(params["area_id"], "kitchen");
    }
}
