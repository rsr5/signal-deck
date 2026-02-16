//! Monty Python runtime wrapper for Signal Deck.
//!
//! Wraps `pydantic/monty` to execute user Python snippets in a sandboxed
//! interpreter. External functions (`state`, `states`, etc.) pause
//! execution and return control to the host so TypeScript can fulfill the
//! request via the HA WebSocket API.

use monty::{
    CollectStringPrint, DictPairs, ExternalResult, MontyException, MontyObject, MontyRun,
    NoLimitTracker, RunProgress, Snapshot,
};

/// External function names exposed to Python code.
/// The HA context is implied — no `ha_` prefix needed.
const HA_EXTERNAL_FUNCTIONS: &[&str] = &[
    "state",
    "states",
    "history",
    "statistics",
    "call_service",
    "show",
    "room",
    "rooms",
    "ago",
    "logbook",
    "template",
    "traces",
    "devices",
    "entities",
    "check_config",
    "error_log",
    "now",
    "services",
    "plot_line",
    "plot_bar",
    "plot_pie",
    "plot_series",
];

/// Result of evaluating a Python snippet.
pub enum MontyEvalResult {
    /// Execution completed — return the output and optional result value.
    Complete {
        /// Captured print() output.
        output: String,
        /// The final expression value (None is suppressed).
        result: Option<MontyObject>,
    },
    /// Execution paused at an external function call — we need TS to fulfill it.
    HostCallNeeded {
        /// Captured print() output so far.
        output: String,
        /// Which function was called.
        function_name: String,
        /// Positional arguments as JSON-compatible strings.
        args: Vec<MontyObject>,
        /// The frozen execution state to resume later.
        snapshot: Snapshot<NoLimitTracker>,
    },
    /// Parse or runtime error.
    Error(String),
}

/// Execute a Python code snippet using Monty.
///
/// If `context` is non-empty, it is prepended to `code` so that variables
/// and functions defined in earlier REPL lines are visible. Print output
/// produced by the context prefix is stripped from the result.
///
/// If `last_result` is provided, it is passed as the `_` input variable
/// so that the previous result is available with full type fidelity
/// (dataclasses retain dot-access, no serialization).
///
/// Returns a `MontyEvalResult` indicating whether execution completed,
/// paused at an external function, or failed.
pub fn eval_python(context: &str, code: &str, last_result: Option<&MontyObject>) -> MontyEvalResult {
    // Build the full script: context prefix (if any) + new code.
    let full_code = if context.is_empty() {
        code.to_owned()
    } else {
        format!("{context}\n{code}")
    };

    // Build input_names and input_values for the `_` variable.
    let mut input_names: Vec<String> = Vec::new();
    let mut input_values: Vec<MontyObject> = Vec::new();
    if let Some(obj) = last_result {
        input_names.push("_".to_string());
        input_values.push(obj.clone());
    }

    // Parse the code.
    let ext_fns: Vec<String> = HA_EXTERNAL_FUNCTIONS.iter().map(|s| s.to_string()).collect();
    let runner = match MontyRun::new(full_code, "signal-deck.py", input_names.clone(), ext_fns) {
        Ok(r) => r,
        Err(e) => return MontyEvalResult::Error(format_monty_error(&e)),
    };

    // If we have context, run it once first just to measure its print output length.
    // Then run the full script and strip the prefix output.
    let context_output_len = if !context.is_empty() {
        measure_context_output(context, last_result)
    } else {
        0
    };

    let mut print_buf = CollectStringPrint::new();
    let progress = match runner.start(input_values, NoLimitTracker, &mut print_buf) {
        Ok(p) => p,
        Err(e) => return MontyEvalResult::Error(format_monty_error(&e)),
    };

    let full_output = print_buf.into_output();
    // Strip the context prefix output — only show what the new code printed.
    let output = strip_context_output(&full_output, context_output_len);
    finish_progress(progress, output)
}

/// Resume a paused Monty execution with the result of an external function call.
pub fn resume_with_result(
    snapshot: Snapshot<NoLimitTracker>,
    result: ExternalResult,
) -> MontyEvalResult {
    let mut print_buf = CollectStringPrint::new();
    let progress = match snapshot.run(result, &mut print_buf) {
        Ok(p) => p,
        Err(e) => return MontyEvalResult::Error(format_monty_error(&e)),
    };

    let output = print_buf.into_output();
    finish_progress(progress, output)
}

/// Process a RunProgress to completion or pause.
fn finish_progress(
    progress: RunProgress<NoLimitTracker>,
    output: String,
) -> MontyEvalResult {
    loop {
        match progress {
            RunProgress::Complete(value) => {
                let result = match &value {
                    MontyObject::None => None,
                    _ => Some(value),
                };
                return MontyEvalResult::Complete {
                    output,
                    result,
                };
            }
            RunProgress::FunctionCall {
                function_name,
                args,
                state,
                ..
            } => {
                return MontyEvalResult::HostCallNeeded {
                    output,
                    function_name,
                    args,
                    snapshot: state,
                };
            }
            RunProgress::ResolveFutures(_) => {
                return MontyEvalResult::Error(
                    "Async operations are not supported in Signal Deck.".to_string(),
                );
            }
            RunProgress::OsCall { .. } => {
                return MontyEvalResult::Error(
                    "OS/filesystem operations are not supported in Signal Deck.".to_string(),
                );
            }
        }
    }
}

/// Convert MontyObject to a serde_json::Value for use in host call params.
pub fn monty_obj_to_json(obj: &MontyObject) -> serde_json::Value {
    match obj {
        MontyObject::None => serde_json::Value::Null,
        MontyObject::Bool(b) => serde_json::Value::Bool(*b),
        MontyObject::Int(n) => serde_json::json!(*n),
        MontyObject::Float(f) => serde_json::json!(*f),
        MontyObject::String(s) => serde_json::Value::String(s.clone()),
        MontyObject::List(items) => {
            let arr: Vec<serde_json::Value> = items.iter().map(monty_obj_to_json).collect();
            serde_json::Value::Array(arr)
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
        MontyObject::Tuple(items) => {
            let arr: Vec<serde_json::Value> = items.iter().map(monty_obj_to_json).collect();
            serde_json::Value::Array(arr)
        }
        other => serde_json::Value::String(format!("{other}")),
    }
}

/// Convert a serde_json::Value back to a MontyObject for resuming execution.
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
            let items: Vec<MontyObject> = arr.iter().map(json_to_monty_obj).collect();
            MontyObject::List(items)
        }
        serde_json::Value::Object(map) => {
            let pairs: Vec<(MontyObject, MontyObject)> = map
                .iter()
                .map(|(k, v)| (MontyObject::String(k.clone()), json_to_monty_obj(v)))
                .collect();
            MontyObject::Dict(monty::DictPairs::from(pairs))
        }
    }
}

/// Format a MontyException into a user-friendly error string.
fn format_monty_error(e: &MontyException) -> String {
    format!("{e}")
}

/// Run context code in isolation to measure how many bytes of print output it produces.
/// This lets us strip the prefix output when running context + new code together.
fn measure_context_output(context: &str, last_result: Option<&MontyObject>) -> usize {
    // Build same input_names/values as the real eval so context code can reference `_`.
    let mut input_names: Vec<String> = Vec::new();
    let mut input_values: Vec<MontyObject> = Vec::new();
    if let Some(obj) = last_result {
        input_names.push("_".to_string());
        input_values.push(obj.clone());
    }

    let ext_fns: Vec<String> = HA_EXTERNAL_FUNCTIONS.iter().map(|s| s.to_string()).collect();
    let runner = match MontyRun::new(context.to_owned(), "signal-deck.py", input_names, ext_fns) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let mut print_buf = CollectStringPrint::new();
    match runner.start(input_values, NoLimitTracker, &mut print_buf) {
        Ok(_) => print_buf.into_output().len(),
        Err(_) => 0,
    }
}

/// Strip context prefix output from the full output.
/// Uses byte offset measured by `measure_context_output`.
fn strip_context_output(full_output: &str, context_output_len: usize) -> String {
    if context_output_len == 0 || context_output_len >= full_output.len() {
        return full_output.to_string();
    }
    full_output[context_output_len..].to_string()
}

/// Map an external function call to the appropriate HA host call method + params.
pub fn map_ext_call_to_host_call(
    function_name: &str,
    args: &[MontyObject],
) -> Option<(&'static str, serde_json::Value)> {
    match function_name {
        "state" => {
            // state("sensor.temp") → get_state
            let entity_id = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            Some(("get_state", serde_json::json!({ "entity_id": entity_id })))
        }
        "states" => {
            // states() or states("sensor") → get_states
            let domain = args.first().and_then(|a| match a {
                MontyObject::String(s) => Some(s.clone()),
                _ => None,
            });
            let params = match domain {
                Some(d) => serde_json::json!({ "domain": d }),
                None => serde_json::json!({}),
            };
            Some(("get_states", params))
        }
        "history" => {
            // history("sensor.temp", 6) → get_history
            let entity_id = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            let hours = args.get(1).and_then(|a| match a {
                MontyObject::Int(n) => Some(*n),
                MontyObject::Float(f) => Some(*f as i64),
                _ => None,
            }).unwrap_or(6);
            Some(("get_history", serde_json::json!({
                "entity_id": entity_id,
                "hours": hours,
            })))
        }
        "call_service" => {
            // call_service("light", "turn_on", {"entity_id": "light.kitchen"})
            let domain = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            let service = args.get(1).map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            let data = args.get(2).map(monty_obj_to_json).unwrap_or(serde_json::json!({}));
            Some(("call_service", serde_json::json!({
                "domain": domain,
                "service": service,
                "service_data": data,
            })))
        }
        "show" => {
            // show() is handled locally, not a host call.
            None
        }
        "room" => {
            // room("Living Room") → get_area_entities
            let area = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            Some(("get_area_entities", serde_json::json!({ "area": area })))
        }
        "rooms" => {
            // rooms() → get_areas (list all areas)
            Some(("get_areas", serde_json::json!({})))
        }
        "statistics" => {
            // statistics("sensor.temp", hours=24, period="hour") → get_statistics
            let entity_id = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            let hours = args.get(1).and_then(|a| match a {
                MontyObject::Int(n) => Some(*n),
                MontyObject::Float(f) => Some(*f as i64),
                _ => None,
            }).unwrap_or(24);
            let period = args.get(2).and_then(|a| match a {
                MontyObject::String(s) => Some(s.clone()),
                _ => None,
            }).unwrap_or_else(|| {
                // Auto-select period based on hours.
                if hours <= 6 { "5minute".to_string() }
                else if hours <= 72 { "hour".to_string() }
                else { "day".to_string() }
            });
            Some(("get_statistics", serde_json::json!({
                "entity_id": entity_id,
                "hours": hours,
                "period": period,
            })))
        }
        "ago" => {
            // ago() is handled locally by the engine, not a host call.
            None
        }
        "logbook" => {
            // logbook("entity_id", hours=6) → get_logbook
            let entity_id = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            let hours = args.get(1).and_then(|a| match a {
                MontyObject::Int(n) => Some(*n),
                MontyObject::Float(f) => Some(*f as i64),
                _ => None,
            }).unwrap_or(6);
            Some(("get_logbook", serde_json::json!({
                "entity_id": entity_id,
                "hours": hours,
            })))
        }
        "template" => {
            // template("{{ states('sensor.temp') }}") → render_template
            let tpl = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            Some(("render_template", serde_json::json!({
                "template": tpl,
            })))
        }
        "traces" => {
            // traces("automation.xyz") → get_traces
            // traces() → list all recent traces
            let automation_id = args.first().and_then(|a| match a {
                MontyObject::String(s) => Some(s.clone()),
                _ => None,
            });
            match automation_id {
                Some(id) => Some(("get_trace", serde_json::json!({ "automation_id": id }))),
                None => Some(("list_traces", serde_json::json!({}))),
            }
        }
        "devices" => {
            // devices() → list all devices
            // devices("keyword") → search devices
            let query = args.first().and_then(|a| match a {
                MontyObject::String(s) => Some(s.clone()),
                _ => None,
            });
            match query {
                Some(q) => Some(("get_devices", serde_json::json!({ "query": q }))),
                None => Some(("get_devices", serde_json::json!({}))),
            }
        }
        "entities" => {
            // entities("entity_id") → get entity registry entry (integration, device, platform)
            let entity_id = args.first().map(|a| match a {
                MontyObject::String(s) => s.clone(),
                other => format!("{other}"),
            }).unwrap_or_default();
            Some(("get_entity_entry", serde_json::json!({ "entity_id": entity_id })))
        }
        "check_config" => {
            // check_config() → validate HA configuration
            Some(("check_config", serde_json::json!({})))
        }
        "error_log" => {
            // error_log() → fetch HA error log
            Some(("get_error_log", serde_json::json!({})))
        }
        "now" => {
            // now() → get current date/time from the browser
            Some(("get_datetime", serde_json::json!({})))
        }
        "services" => {
            // services() → list all available services
            // services("domain") → list services for a specific domain
            let domain = args.first().and_then(|a| match a {
                MontyObject::String(s) => Some(s.clone()),
                _ => None,
            });
            match domain {
                Some(d) => Some(("get_services", serde_json::json!({ "domain": d }))),
                None => Some(("get_services", serde_json::json!({}))),
            }
        }
        // Chart functions are handled locally by the engine, not host calls.
        "plot_line" | "plot_bar" | "plot_pie" | "plot_series" => None,
        _ => None,
    }
}

/// Convert a single HA entity JSON to a `MontyObject::Dataclass` named `EntityState`.
///
/// Fields: entity_id, state, attributes, last_changed, last_updated,
///         domain, object_id, name, is_on, is_off
///
/// The dataclass is frozen (immutable) and has no methods.
pub fn json_to_entity_state(value: &serde_json::Value) -> MontyObject {
    let entity_id = value
        .get("entity_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = value
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("")
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

    // Derive domain and object_id from entity_id.
    let (domain, object_id) = entity_id
        .split_once('.')
        .map(|(d, o)| (d.to_string(), o.to_string()))
        .unwrap_or_else(|| (String::new(), entity_id.clone()));

    // Extract friendly_name for the `name` field.
    let friendly_name = value
        .get("attributes")
        .and_then(|a| a.get("friendly_name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&entity_id)
        .to_string();

    // is_on / is_off
    let is_on = matches!(state.as_str(), "on" | "home" | "open" | "playing" | "active");
    let is_off = matches!(state.as_str(), "off" | "not_home" | "closed" | "idle" | "paused" | "standby");

    // Convert attributes to a MontyObject::Dict.
    let attributes = value
        .get("attributes")
        .cloned()
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
    let attrs_obj = json_to_monty_obj(&attributes);

    // Build the field_names in a stable order.
    let field_names = vec![
        "entity_id".into(),
        "state".into(),
        "attributes".into(),
        "last_changed".into(),
        "last_updated".into(),
        "domain".into(),
        "object_id".into(),
        "name".into(),
        "is_on".into(),
        "is_off".into(),
    ];

    // Build attrs as DictPairs.
    let pairs: Vec<(MontyObject, MontyObject)> = vec![
        (MontyObject::String("entity_id".into()), MontyObject::String(entity_id)),
        (MontyObject::String("state".into()), MontyObject::String(state)),
        (MontyObject::String("attributes".into()), attrs_obj),
        (MontyObject::String("last_changed".into()), MontyObject::String(last_changed)),
        (MontyObject::String("last_updated".into()), MontyObject::String(last_updated)),
        (MontyObject::String("domain".into()), MontyObject::String(domain)),
        (MontyObject::String("object_id".into()), MontyObject::String(object_id)),
        (MontyObject::String("name".into()), MontyObject::String(friendly_name)),
        (MontyObject::String("is_on".into()), MontyObject::Bool(is_on)),
        (MontyObject::String("is_off".into()), MontyObject::Bool(is_off)),
    ];

    MontyObject::Dataclass {
        name: "EntityState".to_string(),
        type_id: 0,
        field_names,
        attrs: DictPairs::from(pairs),
        methods: vec![],
        frozen: true,
    }
}

/// Convert a JSON array of HA entities to a list of EntityState dataclasses.
pub fn json_to_entity_state_list(value: &serde_json::Value) -> MontyObject {
    match value.as_array() {
        Some(arr) => {
            let items: Vec<MontyObject> = arr.iter().map(json_to_entity_state).collect();
            MontyObject::List(items)
        }
        None => MontyObject::List(vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entity_json() -> serde_json::Value {
        serde_json::json!({
            "entity_id": "sensor.living_room_temp",
            "state": "22.5",
            "last_changed": "2026-02-15T10:30:00Z",
            "last_updated": "2026-02-15T10:31:00Z",
            "attributes": {
                "device_class": "temperature",
                "unit_of_measurement": "°C",
                "friendly_name": "Living Room Temperature"
            }
        })
    }

    #[test]
    fn test_entity_state_is_dataclass() {
        let obj = json_to_entity_state(&sample_entity_json());
        match &obj {
            MontyObject::Dataclass { name, frozen, .. } => {
                assert_eq!(name, "EntityState");
                assert!(*frozen);
            }
            other => panic!("Expected Dataclass, got: {other:?}"),
        }
    }

    #[test]
    fn test_entity_state_fields() {
        let obj = json_to_entity_state(&sample_entity_json());
        if let MontyObject::Dataclass { field_names, attrs, .. } = &obj {
            assert_eq!(field_names.len(), 10);
            assert_eq!(field_names[0], "entity_id");
            assert_eq!(field_names[5], "domain");
            assert_eq!(field_names[8], "is_on");

            // Check attrs by iterating DictPairs.
            let pairs: Vec<_> = attrs.into_iter().collect();
            // entity_id
            assert_eq!(pairs[0].1, MontyObject::String("sensor.living_room_temp".into()));
            // state
            assert_eq!(pairs[1].1, MontyObject::String("22.5".into()));
            // domain (derived)
            assert_eq!(pairs[5].1, MontyObject::String("sensor".into()));
            // object_id (derived)
            assert_eq!(pairs[6].1, MontyObject::String("living_room_temp".into()));
            // name (from friendly_name)
            assert_eq!(pairs[7].1, MontyObject::String("Living Room Temperature".into()));
        } else {
            panic!("Expected Dataclass");
        }
    }

    #[test]
    fn test_entity_state_is_on_off() {
        // "on" state
        let on_json = serde_json::json!({
            "entity_id": "light.kitchen",
            "state": "on",
            "attributes": {}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&on_json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[8].1, MontyObject::Bool(true), "is_on should be true");
            assert_eq!(pairs[9].1, MontyObject::Bool(false), "is_off should be false");
        }

        // "off" state
        let off_json = serde_json::json!({
            "entity_id": "light.kitchen",
            "state": "off",
            "attributes": {}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&off_json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[8].1, MontyObject::Bool(false), "is_on should be false");
            assert_eq!(pairs[9].1, MontyObject::Bool(true), "is_off should be true");
        }

        // numeric state (neither on nor off)
        let num_json = serde_json::json!({
            "entity_id": "sensor.temp",
            "state": "22.5",
            "attributes": {}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&num_json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[8].1, MontyObject::Bool(false), "is_on should be false for numeric");
            assert_eq!(pairs[9].1, MontyObject::Bool(false), "is_off should be false for numeric");
        }
    }

    #[test]
    fn test_entity_state_domain_derivation() {
        let json = serde_json::json!({
            "entity_id": "binary_sensor.front_door",
            "state": "off",
            "attributes": {"device_class": "door"}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[5].1, MontyObject::String("binary_sensor".into()));
            assert_eq!(pairs[6].1, MontyObject::String("front_door".into()));
        }
    }

    #[test]
    fn test_entity_state_name_fallback() {
        // No friendly_name → falls back to entity_id.
        let json = serde_json::json!({
            "entity_id": "sensor.temp",
            "state": "22.5",
            "attributes": {}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[7].1, MontyObject::String("sensor.temp".into()));
        }
    }

    #[test]
    fn test_entity_state_attributes_preserved() {
        let json = sample_entity_json();
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            // attrs[2] is the attributes dict.
            if let MontyObject::Dict(inner) = &pairs[2].1 {
                let inner_pairs: Vec<_> = inner.into_iter().collect();
                assert!(inner_pairs.len() >= 3); // device_class, unit, friendly_name
            } else {
                panic!("Expected Dict for attributes");
            }
        }
    }

    #[test]
    fn test_entity_state_list() {
        let json = serde_json::json!([
            {"entity_id": "sensor.a", "state": "1", "attributes": {}},
            {"entity_id": "sensor.b", "state": "2", "attributes": {}}
        ]);
        let obj = json_to_entity_state_list(&json);
        if let MontyObject::List(items) = &obj {
            assert_eq!(items.len(), 2);
            assert!(matches!(&items[0], MontyObject::Dataclass { name, .. } if name == "EntityState"));
            assert!(matches!(&items[1], MontyObject::Dataclass { name, .. } if name == "EntityState"));
        } else {
            panic!("Expected List");
        }
    }

    #[test]
    fn test_entity_state_list_empty() {
        let json = serde_json::json!([]);
        let obj = json_to_entity_state_list(&json);
        if let MontyObject::List(items) = &obj {
            assert!(items.is_empty());
        } else {
            panic!("Expected List");
        }
    }

    #[test]
    fn test_entity_state_home_state() {
        let json = serde_json::json!({
            "entity_id": "person.robin",
            "state": "home",
            "attributes": {"friendly_name": "Robin"}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[8].1, MontyObject::Bool(true), "home → is_on");
            assert_eq!(pairs[9].1, MontyObject::Bool(false), "home → !is_off");
        }
    }

    #[test]
    fn test_entity_state_not_home_state() {
        let json = serde_json::json!({
            "entity_id": "person.robin",
            "state": "not_home",
            "attributes": {"friendly_name": "Robin"}
        });
        if let MontyObject::Dataclass { attrs, .. } = json_to_entity_state(&json) {
            let pairs: Vec<_> = attrs.into_iter().collect();
            assert_eq!(pairs[8].1, MontyObject::Bool(false), "not_home → !is_on");
            assert_eq!(pairs[9].1, MontyObject::Bool(true), "not_home → is_off");
        }
    }

    #[test]
    fn test_entity_state_repr() {
        let json = serde_json::json!({
            "entity_id": "light.kitchen",
            "state": "on",
            "attributes": {"friendly_name": "Kitchen Light"}
        });
        let obj = json_to_entity_state(&json);
        let repr = format!("{obj}");
        // Dataclass repr should contain the name and key fields.
        assert!(repr.contains("EntityState"), "Repr: {repr}");
        assert!(repr.contains("light.kitchen"), "Repr: {repr}");
        assert!(repr.contains("on"), "Repr: {repr}");
    }

    #[test]
    fn test_map_ext_call_room() {
        let args = vec![MontyObject::String("Living Room".to_string())];
        let result = map_ext_call_to_host_call("room", &args);
        assert!(result.is_some(), "room() should map to a host call");
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_area_entities");
        assert_eq!(params["area"], "Living Room");
    }

    #[test]
    fn test_map_ext_call_rooms() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("rooms", &args);
        assert!(result.is_some(), "rooms() should map to a host call");
        let (method, _params) = result.unwrap();
        assert_eq!(method, "get_areas");
    }

    #[test]
    fn test_map_ext_call_show_is_none() {
        let args = vec![MontyObject::String("hello".to_string())];
        let result = map_ext_call_to_host_call("show", &args);
        assert!(result.is_none(), "show() should not be a host call");
    }

    #[test]
    fn test_map_ext_call_state() {
        let args = vec![MontyObject::String("sensor.temp".to_string())];
        let result = map_ext_call_to_host_call("state", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_state");
        assert_eq!(params["entity_id"], "sensor.temp");
    }

    #[test]
    fn test_map_ext_call_states_with_domain() {
        let args = vec![MontyObject::String("light".to_string())];
        let result = map_ext_call_to_host_call("states", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_states");
        assert_eq!(params["domain"], "light");
    }

    #[test]
    fn test_map_ext_call_states_no_args() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("states", &args);
        assert!(result.is_some());
        let (method, _params) = result.unwrap();
        assert_eq!(method, "get_states");
    }

    #[test]
    fn test_map_ext_call_unknown() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("unknown_fn", &args);
        assert!(result.is_none(), "unknown function should return None");
    }

    #[test]
    fn test_ha_external_functions_contains_room() {
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"room"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"rooms"));
    }

    #[test]
    fn test_ha_external_functions_contains_statistics() {
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"statistics"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"ago"));
    }

    #[test]
    fn test_map_ext_call_statistics() {
        let args = vec![
            MontyObject::String("sensor.temp".to_string()),
            MontyObject::Int(24),
        ];
        let result = map_ext_call_to_host_call("statistics", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_statistics");
        assert_eq!(params["entity_id"], "sensor.temp");
        assert_eq!(params["hours"], 24);
        assert_eq!(params["period"], "hour");
    }

    #[test]
    fn test_map_ext_call_statistics_auto_period() {
        // Short period → 5minute
        let args = vec![
            MontyObject::String("sensor.temp".to_string()),
            MontyObject::Int(3),
        ];
        let (_, params) = map_ext_call_to_host_call("statistics", &args).unwrap();
        assert_eq!(params["period"], "5minute");

        // Long period → day
        let args = vec![
            MontyObject::String("sensor.temp".to_string()),
            MontyObject::Int(168),
        ];
        let (_, params) = map_ext_call_to_host_call("statistics", &args).unwrap();
        assert_eq!(params["period"], "day");
    }

    #[test]
    fn test_map_ext_call_ago_is_none() {
        let args = vec![MontyObject::String("6h".to_string())];
        let result = map_ext_call_to_host_call("ago", &args);
        assert!(result.is_none(), "ago() should not be a host call");
    }

    // --- New introspection function tests ---

    #[test]
    fn test_map_ext_call_logbook() {
        let args = vec![
            MontyObject::String("light.kitchen".to_string()),
            MontyObject::Int(12),
        ];
        let result = map_ext_call_to_host_call("logbook", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_logbook");
        assert_eq!(params["entity_id"], "light.kitchen");
        assert_eq!(params["hours"], 12);
    }

    #[test]
    fn test_map_ext_call_logbook_default_hours() {
        let args = vec![MontyObject::String("sensor.temp".to_string())];
        let (_, params) = map_ext_call_to_host_call("logbook", &args).unwrap();
        assert_eq!(params["hours"], 6);
    }

    #[test]
    fn test_map_ext_call_template() {
        let args = vec![MontyObject::String("{{ states('sensor.temp') }}".to_string())];
        let result = map_ext_call_to_host_call("template", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "render_template");
        assert_eq!(params["template"], "{{ states('sensor.temp') }}");
    }

    #[test]
    fn test_map_ext_call_traces_specific() {
        let args = vec![MontyObject::String("automation.motion_lights".to_string())];
        let result = map_ext_call_to_host_call("traces", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_trace");
        assert_eq!(params["automation_id"], "automation.motion_lights");
    }

    #[test]
    fn test_map_ext_call_traces_list_all() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("traces", &args);
        assert!(result.is_some());
        let (method, _) = result.unwrap();
        assert_eq!(method, "list_traces");
    }

    #[test]
    fn test_map_ext_call_devices_no_args() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("devices", &args);
        assert!(result.is_some());
        let (method, _) = result.unwrap();
        assert_eq!(method, "get_devices");
    }

    #[test]
    fn test_map_ext_call_devices_with_query() {
        let args = vec![MontyObject::String("hue".to_string())];
        let result = map_ext_call_to_host_call("devices", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_devices");
        assert_eq!(params["query"], "hue");
    }

    #[test]
    fn test_map_ext_call_entities() {
        let args = vec![MontyObject::String("sensor.temp".to_string())];
        let result = map_ext_call_to_host_call("entities", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_entity_entry");
        assert_eq!(params["entity_id"], "sensor.temp");
    }

    #[test]
    fn test_map_ext_call_check_config() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("check_config", &args);
        assert!(result.is_some());
        let (method, _) = result.unwrap();
        assert_eq!(method, "check_config");
    }

    #[test]
    fn test_map_ext_call_error_log() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("error_log", &args);
        assert!(result.is_some());
        let (method, _) = result.unwrap();
        assert_eq!(method, "get_error_log");
    }

    #[test]
    fn test_ha_external_functions_contains_new_functions() {
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"logbook"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"template"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"traces"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"devices"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"entities"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"check_config"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"error_log"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"now"));
        assert!(HA_EXTERNAL_FUNCTIONS.contains(&"services"));
    }

    #[test]
    fn test_map_ext_call_now() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("now", &args);
        assert!(result.is_some());
        let (method, _) = result.unwrap();
        assert_eq!(method, "get_datetime");
    }

    #[test]
    fn test_map_ext_call_services_no_args() {
        let args: Vec<MontyObject> = vec![];
        let result = map_ext_call_to_host_call("services", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_services");
        assert!(params.get("domain").is_none());
    }

    #[test]
    fn test_map_ext_call_services_with_domain() {
        let args = vec![MontyObject::String("light".into())];
        let result = map_ext_call_to_host_call("services", &args);
        assert!(result.is_some());
        let (method, params) = result.unwrap();
        assert_eq!(method, "get_services");
        assert_eq!(params["domain"], "light");
    }

}
