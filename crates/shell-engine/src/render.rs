use serde::{Deserialize, Serialize};

/// A render spec is the output of the shell engine.
/// TypeScript receives this as JSON and renders it to DOM.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RenderSpec {
    /// Plain text output.
    #[serde(rename = "text")]
    Text { content: String },

    /// Error message.
    #[serde(rename = "error")]
    Error { message: String },

    /// A table with headers and rows.
    #[serde(rename = "table")]
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },

    /// A host call request — TypeScript must fulfill this and call back.
    #[serde(rename = "host_call")]
    HostCall {
        call_id: String,
        method: String,
        params: serde_json::Value,
    },

    /// Multiple specs stacked vertically.
    #[serde(rename = "vstack")]
    VStack { children: Vec<RenderSpec> },

    /// Multiple specs laid out horizontally.
    #[serde(rename = "hstack")]
    HStack { children: Vec<RenderSpec> },

    /// Help text.
    #[serde(rename = "help")]
    Help { content: String },

    /// A rich entity card — mini entity display with icon, state, attributes.
    #[serde(rename = "entity_card")]
    EntityCard {
        entity_id: String,
        icon: String,
        name: String,
        state: String,
        state_color: String,
        unit: Option<String>,
        domain: String,
        device_class: Option<String>,
        last_changed: String,
        attributes: Vec<(String, String)>,
    },

    /// A key-value display (list of labeled pairs).
    #[serde(rename = "key_value")]
    KeyValue {
        title: Option<String>,
        pairs: Vec<(String, String)>,
    },

    /// A colored badge.
    #[serde(rename = "badge")]
    Badge { label: String, color: String },

    /// Text content with a copy-to-clipboard button.
    #[serde(rename = "copyable")]
    Copyable { content: String, label: Option<String> },

    /// A dim summary/info line (entity counts, timing, etc.).
    #[serde(rename = "summary")]
    Summary { content: String },

    /// An AI assistant response.
    #[serde(rename = "assistant")]
    Assistant {
        response: String,
        agent: String,
        snippets: Vec<String>,
    },

    /// A sparkline chart — SVG polyline for numeric time series.
    #[serde(rename = "sparkline")]
    Sparkline {
        entity_id: String,
        name: String,
        unit: Option<String>,
        /// Data points: (timestamp_ms, value).
        points: Vec<(f64, f64)>,
        min: f64,
        max: f64,
        current: f64,
    },

    /// A state timeline — HA-style colored bar showing state changes over time.
    #[serde(rename = "timeline")]
    Timeline {
        entity_id: String,
        name: String,
        /// Segments: (start_ms, end_ms, state, color).
        segments: Vec<(f64, f64, String, String)>,
        start_time: f64,
        end_time: f64,
    },

    /// A rich logbook display — vertical timeline of state changes with context.
    #[serde(rename = "logbook")]
    Logbook {
        entity_id: String,
        entries: Vec<LogbookEntry>,
    },

    /// A rich trace list — automation execution traces with trigger, steps, timing, errors.
    #[serde(rename = "trace_list")]
    TraceList {
        /// The automation entity_id if viewing a specific automation, or None for all.
        automation_id: Option<String>,
        entries: Vec<TraceEntry>,
    },

    /// An ECharts chart — rendered by TypeScript using the ECharts library.
    #[serde(rename = "echarts")]
    ECharts {
        /// The full ECharts option object (serialised as JSON).
        option: serde_json::Value,
        /// Optional chart title (shown above the chart).
        title: Option<String>,
        /// Chart height in pixels (default 300).
        height: u32,
    },

    /// A rich calendar events display — upcoming events with dates, times, locations.
    #[serde(rename = "calendar_events")]
    CalendarEvents {
        entity_id: String,
        entries: Vec<CalendarEventEntry>,
    },
}

/// A single logbook entry — a state change event with context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogbookEntry {
    pub when: String,
    pub name: String,
    pub state: Option<String>,
    pub message: Option<String>,
    pub entity_id: Option<String>,
    pub context_user: Option<String>,
    pub context_event: Option<String>,
    pub context_domain: Option<String>,
    pub context_service: Option<String>,
    pub context_entity: Option<String>,
    pub context_entity_name: Option<String>,
}

/// A single automation trace entry — one execution run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEntry {
    pub run_id: String,
    /// The automation entity_id (e.g. "automation.lights_on") — present in list_traces.
    pub automation: Option<String>,
    /// Execution state: "stopped", "running", etc.
    pub state: String,
    /// ISO timestamp when the trace started.
    pub start: String,
    /// ISO timestamp when the trace finished (if completed).
    pub finish: Option<String>,
    /// What triggered the automation (e.g. "state of sensor.motion").
    pub trigger: Option<String>,
    /// The last step reached (e.g. "action/0").
    pub last_step: Option<String>,
    /// Script execution result: "finished", "error", "aborted", etc.
    pub execution: Option<String>,
    /// Error message if the trace failed.
    pub error: Option<String>,
}

/// A single calendar event — summary, start/end, location.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEventEntry {
    pub summary: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    /// Whether this is an all-day event (no specific time).
    pub all_day: bool,
}

impl RenderSpec {
    pub fn text(content: impl Into<String>) -> Self {
        Self::Text {
            content: content.into(),
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::Error {
            message: message.into(),
        }
    }

    pub fn table(headers: Vec<String>, rows: Vec<Vec<String>>) -> Self {
        Self::Table { headers, rows }
    }

    pub fn host_call(
        call_id: impl Into<String>,
        method: impl Into<String>,
        params: serde_json::Value,
    ) -> Self {
        Self::HostCall {
            call_id: call_id.into(),
            method: method.into(),
            params,
        }
    }

    pub fn help(content: impl Into<String>) -> Self {
        Self::Help {
            content: content.into(),
        }
    }

    pub fn vstack(children: Vec<RenderSpec>) -> Self {
        Self::VStack { children }
    }

    pub fn hstack(children: Vec<RenderSpec>) -> Self {
        Self::HStack { children }
    }

    pub fn entity_card(
        entity_id: impl Into<String>,
        icon: impl Into<String>,
        name: impl Into<String>,
        state: impl Into<String>,
        state_color: impl Into<String>,
        unit: Option<String>,
        domain: impl Into<String>,
        device_class: Option<String>,
        last_changed: impl Into<String>,
        attributes: Vec<(String, String)>,
    ) -> Self {
        Self::EntityCard {
            entity_id: entity_id.into(),
            icon: icon.into(),
            name: name.into(),
            state: state.into(),
            state_color: state_color.into(),
            unit,
            domain: domain.into(),
            device_class,
            last_changed: last_changed.into(),
            attributes,
        }
    }

    pub fn key_value(title: Option<String>, pairs: Vec<(String, String)>) -> Self {
        Self::KeyValue { title, pairs }
    }

    pub fn badge(label: impl Into<String>, color: impl Into<String>) -> Self {
        Self::Badge {
            label: label.into(),
            color: color.into(),
        }
    }

    pub fn copyable(content: impl Into<String>, label: Option<String>) -> Self {
        Self::Copyable {
            content: content.into(),
            label,
        }
    }

    pub fn summary(content: impl Into<String>) -> Self {
        Self::Summary {
            content: content.into(),
        }
    }

    /// Create an assistant response spec, extracting ```signal-deck snippets.
    pub fn assistant(response: impl Into<String>, agent: impl Into<String>) -> Self {
        let response_str: String = response.into();
        let snippets = extract_signal_deck_blocks(&response_str);
        Self::Assistant {
            response: response_str,
            agent: agent.into(),
            snippets,
        }
    }

    /// Create a sparkline spec from numeric time-series data.
    pub fn sparkline(
        entity_id: impl Into<String>,
        name: impl Into<String>,
        unit: Option<String>,
        points: Vec<(f64, f64)>,
    ) -> Self {
        let min = points.iter().map(|(_, v)| *v).fold(f64::INFINITY, f64::min);
        let max = points.iter().map(|(_, v)| *v).fold(f64::NEG_INFINITY, f64::max);
        let current = points.last().map(|(_, v)| *v).unwrap_or(0.0);
        Self::Sparkline {
            entity_id: entity_id.into(),
            name: name.into(),
            unit,
            points,
            min,
            max,
            current,
        }
    }

    /// Create a timeline spec from state-change data.
    pub fn timeline(
        entity_id: impl Into<String>,
        name: impl Into<String>,
        segments: Vec<(f64, f64, String, String)>,
        start_time: f64,
        end_time: f64,
    ) -> Self {
        Self::Timeline {
            entity_id: entity_id.into(),
            name: name.into(),
            segments,
            start_time,
            end_time,
        }
    }

    /// Create a logbook spec from a list of entries.
    pub fn logbook(entity_id: impl Into<String>, entries: Vec<LogbookEntry>) -> Self {
        Self::Logbook {
            entity_id: entity_id.into(),
            entries,
        }
    }

    /// Create a trace list spec from a list of trace entries.
    pub fn trace_list(automation_id: Option<String>, entries: Vec<TraceEntry>) -> Self {
        Self::TraceList {
            automation_id,
            entries,
        }
    }

    /// Create an ECharts chart spec.
    pub fn echarts(option: serde_json::Value, title: Option<String>, height: Option<u32>) -> Self {
        Self::ECharts {
            option,
            title,
            height: height.unwrap_or(300),
        }
    }

    /// Create a calendar events spec from a list of entries.
    pub fn calendar_events(entity_id: impl Into<String>, entries: Vec<CalendarEventEntry>) -> Self {
        Self::CalendarEvents {
            entity_id: entity_id.into(),
            entries,
        }
    }
}

/// Extract ```signal-deck fenced code blocks from a markdown response.
fn extract_signal_deck_blocks(markdown: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut lines = markdown.lines().peekable();

    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed == "```signal-deck" || trimmed == "```signal_deck" {
            // Collect lines until closing fence.
            let mut block_lines = Vec::new();
            for inner in lines.by_ref() {
                let inner_trimmed = inner.trim();
                if inner_trimmed == "```" {
                    break;
                }
                block_lines.push(inner);
            }
            let block = block_lines.join("\n").trim().to_string();
            if !block.is_empty() {
                blocks.push(block);
            }
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_serialization() {
        let spec = RenderSpec::text("hello");
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"text""#));
        assert!(json.contains(r#""content":"hello""#));
    }

    #[test]
    fn test_error_serialization() {
        let spec = RenderSpec::error("bad input");
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"error""#));
        assert!(json.contains(r#""message":"bad input""#));
    }

    #[test]
    fn test_host_call_serialization() {
        let spec = RenderSpec::host_call("c1", "get_states", serde_json::json!({}));
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"host_call""#));
        assert!(json.contains(r#""method":"get_states""#));
    }

    #[test]
    fn test_table_serialization() {
        let spec = RenderSpec::table(
            vec!["entity".into(), "state".into()],
            vec![vec!["sensor.temp".into(), "22.5".into()]],
        );
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"table""#));
        assert!(json.contains("sensor.temp"));
    }

    #[test]
    fn test_entity_card_serialization() {
        let spec = RenderSpec::entity_card(
            "sensor.temp",
            "󰔏",
            "Living Room Temperature",
            "22.5",
            "accent",
            Some("°C".into()),
            "sensor",
            Some("temperature".into()),
            "10:30:00",
            vec![
                ("friendly_name".into(), "Living Room Temperature".into()),
                ("unit_of_measurement".into(), "°C".into()),
            ],
        );
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"entity_card""#));
        assert!(json.contains("sensor.temp"));
        assert!(json.contains("22.5"));
        assert!(json.contains("accent"));
        assert!(json.contains("°C"));
        assert!(json.contains("Living Room Temperature"));
    }

    #[test]
    fn test_key_value_serialization() {
        let spec = RenderSpec::key_value(
            Some("Attributes".into()),
            vec![("unit".into(), "°C".into()), ("class".into(), "temperature".into())],
        );
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"key_value""#));
        assert!(json.contains("Attributes"));
        assert!(json.contains("°C"));
    }

    #[test]
    fn test_badge_serialization() {
        let spec = RenderSpec::badge("on", "success");
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"badge""#));
        assert!(json.contains("success"));
    }

    #[test]
    fn test_copyable_serialization() {
        let spec = RenderSpec::copyable("{\"state\": \"on\"}", Some("JSON".into()));
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"copyable""#));
        assert!(json.contains("JSON"));
    }

    #[test]
    fn test_summary_serialization() {
        let spec = RenderSpec::summary("42 entities");
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"summary""#));
        assert!(json.contains("42 entities"));
    }

    #[test]
    fn test_hstack_serialization() {
        let spec = RenderSpec::hstack(vec![
            RenderSpec::badge("on", "success"),
            RenderSpec::text("hello"),
        ]);
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"hstack""#));
        assert!(json.contains(r#""type":"badge""#));
    }

    #[test]
    fn test_assistant_serialization() {
        let spec = RenderSpec::assistant("Here is some help", "conversation.claude");
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"assistant""#));
        assert!(json.contains("Here is some help"));
        assert!(json.contains("conversation.claude"));
        assert!(json.contains(r#""snippets":[]"#));
    }

    #[test]
    fn test_assistant_extracts_snippets() {
        let response = "Try this:\n\n```signal-deck\nstate('sensor.temp')\n```\n\nAnd also:\n\n```signal-deck\nstates('light')\n```";
        let spec = RenderSpec::assistant(response, "conversation.claude");
        match &spec {
            RenderSpec::Assistant { snippets, .. } => {
                assert_eq!(snippets.len(), 2);
                assert_eq!(snippets[0], "state('sensor.temp')");
                assert_eq!(snippets[1], "states('light')");
            }
            _ => panic!("Expected Assistant variant"),
        }
    }

    #[test]
    fn test_extract_signal_deck_blocks_empty() {
        let blocks = extract_signal_deck_blocks("No code blocks here");
        assert!(blocks.is_empty());
    }

    #[test]
    fn test_extract_signal_deck_blocks_ignores_other_langs() {
        let md = "```python\nprint('hi')\n```\n\n```signal-deck\nstate('a')\n```";
        let blocks = extract_signal_deck_blocks(md);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0], "state('a')");
    }

    #[test]
    fn test_extract_signal_deck_blocks_underscore_variant() {
        let md = "```signal_deck\nstates()\n```";
        let blocks = extract_signal_deck_blocks(md);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0], "states()");
    }

    #[test]
    fn test_sparkline_serialization() {
        let spec = RenderSpec::sparkline(
            "sensor.temp",
            "Temperature",
            Some("°C".into()),
            vec![(1000.0, 20.0), (2000.0, 22.5), (3000.0, 21.0)],
        );
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"sparkline""#));
        assert!(json.contains("sensor.temp"));
        assert!(json.contains("Temperature"));
        assert!(json.contains("°C"));
    }

    #[test]
    fn test_sparkline_min_max() {
        let spec = RenderSpec::sparkline(
            "sensor.temp",
            "Temp",
            None,
            vec![(1000.0, 18.0), (2000.0, 25.0), (3000.0, 21.0)],
        );
        match &spec {
            RenderSpec::Sparkline { min, max, current, .. } => {
                assert_eq!(*min, 18.0);
                assert_eq!(*max, 25.0);
                assert_eq!(*current, 21.0);
            }
            _ => panic!("Expected Sparkline"),
        }
    }

    #[test]
    fn test_timeline_serialization() {
        let spec = RenderSpec::timeline(
            "binary_sensor.door",
            "Front Door",
            vec![
                (1000.0, 2000.0, "off".into(), "#888".into()),
                (2000.0, 3000.0, "on".into(), "#44b556".into()),
            ],
            1000.0,
            3000.0,
        );
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"timeline""#));
        assert!(json.contains("binary_sensor.door"));
        assert!(json.contains("Front Door"));
        assert!(json.contains("#44b556"));
    }

    #[test]
    fn test_logbook_serialization() {
        let entries = vec![
            LogbookEntry {
                when: "2024-01-15T10:30:00Z".into(),
                name: "Kitchen Light".into(),
                state: Some("on".into()),
                message: None,
                entity_id: Some("light.kitchen".into()),
                context_user: Some("Robin".into()),
                context_event: None,
                context_domain: Some("light".into()),
                context_service: Some("turn_on".into()),
                context_entity: None,
                context_entity_name: None,
            },
            LogbookEntry {
                when: "2024-01-15T09:00:00Z".into(),
                name: "Kitchen Light".into(),
                state: Some("off".into()),
                message: None,
                entity_id: Some("light.kitchen".into()),
                context_user: None,
                context_event: None,
                context_domain: Some("automation".into()),
                context_service: None,
                context_entity: Some("automation.lights_off".into()),
                context_entity_name: Some("Lights Off at Dawn".into()),
            },
        ];
        let spec = RenderSpec::logbook("light.kitchen", entries);
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"logbook""#));
        assert!(json.contains("light.kitchen"));
        assert!(json.contains("Kitchen Light"));
        assert!(json.contains("Robin"));
        assert!(json.contains("Lights Off at Dawn"));
    }

    #[test]
    fn test_logbook_roundtrip() {
        let entries = vec![LogbookEntry {
            when: "2024-01-15T10:30:00Z".into(),
            name: "Sensor".into(),
            state: Some("22.5".into()),
            message: Some("changed".into()),
            entity_id: Some("sensor.temp".into()),
            context_user: None,
            context_event: Some("state_changed".into()),
            context_domain: None,
            context_service: None,
            context_entity: None,
            context_entity_name: None,
        }];
        let spec = RenderSpec::logbook("sensor.temp", entries);
        let json = serde_json::to_string(&spec).unwrap();
        let deserialized: RenderSpec = serde_json::from_str(&json).unwrap();
        match deserialized {
            RenderSpec::Logbook { entity_id, entries } => {
                assert_eq!(entity_id, "sensor.temp");
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].name, "Sensor");
                assert_eq!(entries[0].state.as_deref(), Some("22.5"));
            }
            _ => panic!("Expected Logbook variant"),
        }
    }

    #[test]
    fn test_trace_list_serialization() {
        let entries = vec![
            TraceEntry {
                run_id: "abc123".into(),
                automation: Some("automation.lights_on".into()),
                state: "stopped".into(),
                start: "2024-01-15T10:30:00Z".into(),
                finish: Some("2024-01-15T10:30:01Z".into()),
                trigger: Some("state of binary_sensor.motion".into()),
                last_step: Some("action/0".into()),
                execution: Some("finished".into()),
                error: None,
            },
            TraceEntry {
                run_id: "def456".into(),
                automation: Some("automation.alarm".into()),
                state: "stopped".into(),
                start: "2024-01-15T09:00:00Z".into(),
                finish: Some("2024-01-15T09:00:02Z".into()),
                trigger: Some("time 09:00".into()),
                last_step: Some("action/1".into()),
                execution: Some("error".into()),
                error: Some("Service not found".into()),
            },
        ];
        let spec = RenderSpec::trace_list(None, entries);
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains(r#""type":"trace_list""#));
        assert!(json.contains("abc123"));
        assert!(json.contains("automation.lights_on"));
        assert!(json.contains("state of binary_sensor.motion"));
        assert!(json.contains("Service not found"));
    }

    #[test]
    fn test_trace_list_roundtrip() {
        let entries = vec![TraceEntry {
            run_id: "r1".into(),
            automation: None,
            state: "stopped".into(),
            start: "2024-01-15T10:30:00Z".into(),
            finish: None,
            trigger: Some("manual".into()),
            last_step: None,
            execution: Some("finished".into()),
            error: None,
        }];
        let spec = RenderSpec::trace_list(Some("automation.test".into()), entries);
        let json = serde_json::to_string(&spec).unwrap();
        let deserialized: RenderSpec = serde_json::from_str(&json).unwrap();
        match deserialized {
            RenderSpec::TraceList { automation_id, entries } => {
                assert_eq!(automation_id.as_deref(), Some("automation.test"));
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].run_id, "r1");
                assert_eq!(entries[0].trigger.as_deref(), Some("manual"));
            }
            _ => panic!("Expected TraceList variant"),
        }
    }
}
