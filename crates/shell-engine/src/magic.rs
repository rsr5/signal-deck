use crate::render::RenderSpec;

/// A parsed magic command.
#[derive(Debug, PartialEq)]
pub enum MagicCommand {
    /// %ls [domain] — list entities
    Ls(Option<String>),

    /// %get entity_id — show entity state
    Get(String),

    /// %find pattern — glob search entities
    Find(String),

    /// %hist entity_id [-h hours] — show history
    Hist {
        entity_id: String,
        hours: Option<u32>,
    },

    /// %attrs entity_id — show all attributes
    Attrs(String),

    /// %diff entity_a entity_b — compare two entities
    Diff(String, String),

    /// %bundle name — run a named bundle
    Bundle(String),

    /// %fmt format — set output format
    Fmt(String),

    /// %ask question — ask the AI assistant (via HA Conversation)
    Ask(String),

    /// :help — show help
    Help,

    /// :clear — clear the output
    Clear,
}

/// Try to parse a line as a magic command.
/// Returns None if the line is not a magic/command.
pub fn parse_magic(input: &str) -> Option<MagicCommand> {
    let trimmed = input.trim();

    if trimmed == ":help" || trimmed == ":h" {
        return Some(MagicCommand::Help);
    }

    if trimmed == ":clear" || trimmed == ":cls" {
        return Some(MagicCommand::Clear);
    }

    if !trimmed.starts_with('%') {
        return None;
    }

    let parts: Vec<&str> = trimmed[1..].split_whitespace().collect();
    if parts.is_empty() {
        return None;
    }

    match parts[0] {
        "ls" => {
            let domain = parts.get(1).map(|s| s.to_string());
            Some(MagicCommand::Ls(domain))
        }
        "get" => {
            let entity_id = parts.get(1)?;
            Some(MagicCommand::Get(entity_id.to_string()))
        }
        "find" => {
            let pattern = parts.get(1)?;
            Some(MagicCommand::Find(pattern.to_string()))
        }
        "hist" => {
            let entity_id = parts.get(1)?.to_string();
            let mut hours = None;
            if let Some(&flag) = parts.get(2) {
                if flag == "-h" {
                    hours = parts.get(3).and_then(|h| h.parse().ok());
                }
            }
            Some(MagicCommand::Hist { entity_id, hours })
        }
        "bundle" => {
            let name = parts.get(1)?;
            Some(MagicCommand::Bundle(name.to_string()))
        }
        "fmt" => {
            let format = parts.get(1)?;
            Some(MagicCommand::Fmt(format.to_string()))
        }
        "attrs" | "attributes" => {
            let entity_id = parts.get(1)?;
            Some(MagicCommand::Attrs(entity_id.to_string()))
        }
        "diff" | "compare" => {
            let entity_a = parts.get(1)?.to_string();
            let entity_b = parts.get(2)?.to_string();
            Some(MagicCommand::Diff(entity_a, entity_b))
        }
        "ask" | "assistant" => {
            // Everything after %ask is the question.
            let question = trimmed.splitn(2, char::is_whitespace).nth(1)?;
            let question = question.trim();
            if question.is_empty() {
                return None;
            }
            Some(MagicCommand::Ask(question.to_string()))
        }
        _ => None,
    }
}

/// Generate help text.
pub fn help_text() -> RenderSpec {
    RenderSpec::help(
        r#"Signal Deck — The oscilloscope for Home Assistant

Commands:
  :help              Show this help message
  :clear             Clear the output

Magic Commands:
  %ls [domain]       List entities (optionally filter by domain)
  %get <entity_id>   Show entity state
  %find <pattern>    Search entities by glob pattern
  %hist <id> [-h N]  Show entity history (last N hours)
  %attrs <id>        Show all entity attributes
  %diff <id1> <id2>  Compare two entities side-by-side
  %bundle <name>     Run a named bundle
  %fmt <format>      Set output format (table, json, text)
  %ask <question>    Ask the AI assistant (via HA Conversation)

Auto-resolve:
  sensor.temp        → %get sensor.temp
  light              → %ls light

Python API — State & Entities:
  state(id)            Get entity state as EntityState dataclass
  states([domain])     List all states (optionally by domain)
  entities(id)         Get entity registry entry (integration, device, platform)
  devices([query])     List/search devices

Python API — History & Diagnostics:
  history(id, [hours]) Get entity history (default 6h)
  statistics(id, [hours], [period])  Get long-term statistics
  events(id, [hours])  Get calendar events (default 14 days forward)
  logbook([id], [hours])  Get logbook entries
  traces([automation_id]) Get automation traces (all or specific)
  error_log()          Fetch the HA error log
  check_config()       Validate HA configuration

Python API — Rooms & Services:
  room(name)           Get all entities in an area/room
  rooms()              List all areas/rooms
  services([domain])   List available services
  call_service(d,s,{}) Call a HA service (requires confirmation)

Python API — Utilities:
  show(value)          Pretty-print a value
  now()                Get current date/time
  ago(spec)            Relative time (e.g. ago("6h"), ago("2d"))
  template(tpl)        Render a Jinja2 template

Python API — Charts (ECharts):
  plot_line(labels, values, [title])  Line chart
  plot_bar(labels, values, [title])   Bar chart
  plot_pie(data, [title])             Pie chart (data = {name: val})
  plot_series(points, [title])        XY / time-series line chart
  Multi-series: plot_line(labels, {"A": [...], "B": [...]}, title)
  Series data:  plot_series([(x,y),...]) or {"A": [(x,y),...], ...}
  Time axis auto-detected from epoch-ms x values.

Card Config:
  mode: embedded       Normal inline card (default)
  mode: overlay        Tiny launcher button + overlay console
  overlay_position     top | bottom | full (default: top)
  overlay_height       CSS height for top/bottom (default: 50vh)

Keyboard Shortcuts (overlay mode):
  `  (backtick)        Toggle overlay open/close
  Escape               Close overlay
"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_help() {
        assert_eq!(parse_magic(":help"), Some(MagicCommand::Help));
        assert_eq!(parse_magic(":h"), Some(MagicCommand::Help));
    }

    #[test]
    fn test_parse_ls() {
        assert_eq!(parse_magic("%ls"), Some(MagicCommand::Ls(None)));
        assert_eq!(
            parse_magic("%ls binary_sensor"),
            Some(MagicCommand::Ls(Some("binary_sensor".into())))
        );
    }

    #[test]
    fn test_parse_get() {
        assert_eq!(
            parse_magic("%get sensor.temp"),
            Some(MagicCommand::Get("sensor.temp".into()))
        );
        assert_eq!(parse_magic("%get"), None);
    }

    #[test]
    fn test_parse_find() {
        assert_eq!(
            parse_magic("%find *occupied*"),
            Some(MagicCommand::Find("*occupied*".into()))
        );
    }

    #[test]
    fn test_parse_hist() {
        assert_eq!(
            parse_magic("%hist sensor.temp -h 6"),
            Some(MagicCommand::Hist {
                entity_id: "sensor.temp".into(),
                hours: Some(6),
            })
        );
        assert_eq!(
            parse_magic("%hist sensor.temp"),
            Some(MagicCommand::Hist {
                entity_id: "sensor.temp".into(),
                hours: None,
            })
        );
    }

    #[test]
    fn test_parse_bundle() {
        assert_eq!(
            parse_magic("%bundle living_room"),
            Some(MagicCommand::Bundle("living_room".into()))
        );
    }

    #[test]
    fn test_non_magic_returns_none() {
        assert_eq!(parse_magic("ha.state('sensor.temp')"), None);
        assert_eq!(parse_magic("print('hello')"), None);
    }

    #[test]
    fn test_parse_clear() {
        assert_eq!(parse_magic(":clear"), Some(MagicCommand::Clear));
        assert_eq!(parse_magic(":cls"), Some(MagicCommand::Clear));
    }

    #[test]
    fn test_parse_attrs() {
        assert_eq!(
            parse_magic("%attrs sensor.temp"),
            Some(MagicCommand::Attrs("sensor.temp".into()))
        );
        assert_eq!(parse_magic("%attrs"), None);
    }

    #[test]
    fn test_parse_diff() {
        assert_eq!(
            parse_magic("%diff sensor.temp sensor.humidity"),
            Some(MagicCommand::Diff("sensor.temp".into(), "sensor.humidity".into()))
        );
        assert_eq!(parse_magic("%diff sensor.temp"), None);
    }

    #[test]
    fn test_parse_ask() {
        assert_eq!(
            parse_magic("%ask why is the light on?"),
            Some(MagicCommand::Ask("why is the light on?".into()))
        );
        assert_eq!(
            parse_magic("%assistant explain this entity"),
            Some(MagicCommand::Ask("explain this entity".into()))
        );
        // Empty question returns None.
        assert_eq!(parse_magic("%ask"), None);
        assert_eq!(parse_magic("%ask   "), None);
    }
}
