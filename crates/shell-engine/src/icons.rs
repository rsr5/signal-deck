/// Nerd Font icon mapping for Home Assistant entity domains and device classes.
///
/// Uses Nerd Font glyphs — requires a Nerd Font (e.g. Iosevka Nerd Font) to render.

/// Get a Nerd Font icon for an entity based on its domain, device_class, and state.
pub fn entity_icon(entity_id: &str, device_class: Option<&str>, state: Option<&str>) -> &'static str {
    let domain = entity_id.split('.').next().unwrap_or("");
    let st = state.unwrap_or("");

    // Try device_class-specific icon first, then fall back to domain.
    if let Some(dc) = device_class {
        if let Some(icon) = device_class_icon(domain, dc, st) {
            return icon;
        }
    }

    domain_icon(domain, st)
}

/// Icon based on device_class (more specific).
fn device_class_icon(domain: &str, device_class: &str, state: &str) -> Option<&'static str> {
    match (domain, device_class) {
        // Binary sensor device classes
        ("binary_sensor", "door") => Some(if state == "on" { "󰷛" } else { "󰷚" }),       // door open/closed
        ("binary_sensor", "window") => Some(if state == "on" { "󱗔" } else { "󱗓" }),     // window open/closed
        ("binary_sensor", "motion") => Some(if state == "on" { "󰒲" } else { "󰒳" }),     // motion/no motion
        ("binary_sensor", "occupancy") => Some(if state == "on" { "󱁝" } else { "󱁞" }), // occupied/empty
        ("binary_sensor", "lock") => Some(if state == "on" { "󰌿" } else { "󰍁" }),       // unlocked/locked
        ("binary_sensor", "moisture") => Some("󰖌"),   // water drop
        ("binary_sensor", "smoke") => Some("󰗐"),      // smoke
        ("binary_sensor", "gas") => Some("󱗝"),        // gas
        ("binary_sensor", "battery") => Some("󰁹"),    // battery
        ("binary_sensor", "connectivity") => Some(if state == "on" { "󰖩" } else { "󰖪" }),
        ("binary_sensor", "plug") => Some(if state == "on" { "󰚥" } else { "󰚦" }),
        ("binary_sensor", "presence") => Some(if state == "on" { "󰋑" } else { "󰋐" }),
        ("binary_sensor", "problem") => Some(if state == "on" { "󰀨" } else { "󰄬" }),
        ("binary_sensor", "safety") => Some("󰒿"),
        ("binary_sensor", "vibration") => Some("󰾃"),

        // Sensor device classes
        ("sensor", "temperature") => Some("󰔏"),       // thermometer
        ("sensor", "humidity") => Some("󰖌"),           // water drop
        ("sensor", "pressure") => Some("󰀝"),           // gauge
        ("sensor", "battery") => Some("󰁹"),            // battery
        ("sensor", "power") => Some("󰚥"),              // plug
        ("sensor", "energy") => Some("󱐋"),             // lightning
        ("sensor", "voltage") => Some("󱊦"),            // voltage
        ("sensor", "current") => Some("󱊧"),            // current
        ("sensor", "illuminance") => Some("󰃟"),        // brightness
        ("sensor", "co2") | ("sensor", "carbon_dioxide") => Some("󰟤"),
        ("sensor", "pm25") | ("sensor", "pm10") => Some("󰃞"),
        ("sensor", "signal_strength") => Some("󰖩"),
        ("sensor", "timestamp") => Some("󰥔"),
        ("sensor", "duration") => Some("󱎫"),
        ("sensor", "speed") | ("sensor", "wind_speed") => Some("󰖝"),
        ("sensor", "weight") | ("sensor", "mass") => Some("󰖳"),
        ("sensor", "distance") => Some("󰳞"),
        ("sensor", "monetary") => Some("󰗹"),

        // Cover device classes
        ("cover", "garage") => Some(if state == "open" { "󰿘" } else { "󰿗" }),
        ("cover", "blind") | ("cover", "shade") => Some("󰦗"),
        ("cover", "curtain") => Some("󰦗"),

        _ => None,
    }
}

/// Icon based on domain (fallback).
fn domain_icon(domain: &str, state: &str) -> &'static str {
    match domain {
        "light" => if state == "on" { "󰌵" } else { "󰌶" },           // lightbulb on/off
        "switch" => if state == "on" { "󰔡" } else { "󰔢" },         // toggle on/off
        "binary_sensor" => if state == "on" { "󰐾" } else { "󰐽" },  // circle check/empty
        "sensor" => "󰗠",                                              // gauge
        "climate" => "󰃮",                                             // thermostat
        "fan" => "󰈐",                                                 // fan
        "cover" => "󰦗",                                               // blinds
        "lock" => if state == "locked" { "󰍁" } else { "󰌿" },       // lock/unlock
        "camera" => "󰄀",                                              // camera
        "media_player" => "󰕾",                                        // speaker
        "vacuum" => "󰡪",                                              // robot
        "automation" => "󰁪",                                          // cog play
        "script" => "󰯁",                                              // file code
        "scene" => "󰸉",                                               // palette
        "input_boolean" => if state == "on" { "󰨚" } else { "󰨙" },  // checkbox
        "input_number" => "󰎠",                                        // numeric
        "input_select" => "󰒓",                                        // format list
        "input_text" => "󰗊",                                          // text
        "input_datetime" => "󰃰",                                      // calendar clock
        "timer" => "󱎫",                                               // timer
        "counter" => "󰆙",                                             // counter
        "person" => "󰋑",                                              // account
        "zone" => "󰆋",                                                // map marker
        "sun" => "󰖨",                                                 // sun
        "weather" => "󰖐",                                             // cloud
        "device_tracker" => "󰍒",                                      // crosshairs
        "group" => "󰋻",                                               // account group
        "number" => "󰎠",                                              // numeric
        "select" => "󰒓",                                              // list
        "button" => "󰆠",                                              // gesture tap button
        "update" => "󰚰",                                              // package up
        "tts" => "󰗕",                                                 // microphone
        "stt" => "󰗕",                                                 // microphone
        "alarm_control_panel" => "󰀦",                                 // shield
        "remote" => "󰑔",                                              // remote
        "water_heater" => "󰖌",                                        // water
        "humidifier" => "󰖌",                                          // water
        "calendar" => "󰃭",                                            // calendar
        "todo" => "󰄲",                                                // checkbox marked
        "image" => "󰋩",                                               // image
        "notify" => "󰂞",                                              // bell
        _ => "󰘦",                                                     // cube outline (unknown)
    }
}

/// Get a state-colored indicator character.
/// Returns a colored dot string based on state value.
pub fn state_indicator(state: &str) -> &'static str {
    match state {
        "on" | "home" | "open" | "unlocked" | "playing" | "active" | "heat" | "cool" => "●",
        "off" | "away" | "closed" | "locked" | "idle" | "paused" | "standby" => "○",
        "unavailable" => "◌",
        "unknown" => "◌",
        _ => "◦",
    }
}

/// Map a state string to a semantic color name for badges.
/// Returns a color token that TypeScript can map to CSS.
pub fn state_color(state: &str) -> &'static str {
    match state {
        "on" | "home" | "active" | "locked" | "disarmed" | "above_horizon"
        | "heating" | "heat" | "detected" | "connected" => "success",

        "off" | "closed" | "docked" | "below_horizon" | "clear"
        | "disconnected" => "dim",

        "open" | "opening" | "idle" | "standby" | "paused"
        | "armed_home" | "armed_away" | "armed_night" | "dry" | "fan_only"
        | "returning" | "charging" | "discharging" | "cooling" | "cool" | "auto" => "warning",

        "playing" | "away" | "not_home" => "accent",

        "unavailable" | "unknown" | "unlocked" | "unlocking"
        | "jammed" | "problem" | "triggered" | "pending" => "error",

        _ => {
            // Numeric values get "accent" color.
            if state.parse::<f64>().is_ok() {
                "accent"
            } else {
                "dim"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sensor_temperature_icon() {
        let icon = entity_icon("sensor.living_room_temp", Some("temperature"), Some("22.5"));
        assert_eq!(icon, "󰔏");
    }

    #[test]
    fn test_binary_sensor_door_on() {
        let icon = entity_icon("binary_sensor.front_door", Some("door"), Some("on"));
        assert_eq!(icon, "󰷛"); // open door
    }

    #[test]
    fn test_binary_sensor_door_off() {
        let icon = entity_icon("binary_sensor.front_door", Some("door"), Some("off"));
        assert_eq!(icon, "󰷚"); // closed door
    }

    #[test]
    fn test_light_on() {
        let icon = entity_icon("light.living_room", None, Some("on"));
        assert_eq!(icon, "󰌵");
    }

    #[test]
    fn test_light_off() {
        let icon = entity_icon("light.living_room", None, Some("off"));
        assert_eq!(icon, "󰌶");
    }

    #[test]
    fn test_unknown_domain() {
        let icon = entity_icon("foobar.something", None, None);
        assert_eq!(icon, "󰘦");
    }

    #[test]
    fn test_binary_sensor_fallback() {
        let icon = entity_icon("binary_sensor.something", None, Some("on"));
        assert_eq!(icon, "󰐾");
    }

    #[test]
    fn test_switch_on() {
        let icon = entity_icon("switch.pump", None, Some("on"));
        assert_eq!(icon, "󰔡");
    }

    #[test]
    fn test_state_indicator_on() {
        assert_eq!(state_indicator("on"), "●");
    }

    #[test]
    fn test_state_indicator_off() {
        assert_eq!(state_indicator("off"), "○");
    }

    #[test]
    fn test_state_indicator_unavailable() {
        assert_eq!(state_indicator("unavailable"), "◌");
    }

    #[test]
    fn test_state_indicator_numeric() {
        assert_eq!(state_indicator("22.5"), "◦");
    }

    #[test]
    fn test_occupancy_on() {
        let icon = entity_icon("binary_sensor.lr_occupied", Some("occupancy"), Some("on"));
        assert_eq!(icon, "󱁝");
    }

    #[test]
    fn test_motion_on() {
        let icon = entity_icon("binary_sensor.hallway_motion", Some("motion"), Some("on"));
        assert_eq!(icon, "󰒲");
    }

    #[test]
    fn test_person_icon() {
        let icon = entity_icon("person.robin", None, Some("home"));
        assert_eq!(icon, "󰋑");
    }

    #[test]
    fn test_automation_icon() {
        let icon = entity_icon("automation.lights_off", None, Some("on"));
        assert_eq!(icon, "󰁪");
    }

    #[test]
    fn test_state_color_on() {
        assert_eq!(state_color("on"), "success");
    }

    #[test]
    fn test_state_color_off() {
        assert_eq!(state_color("off"), "dim");
    }

    #[test]
    fn test_state_color_open() {
        assert_eq!(state_color("open"), "warning");
    }

    #[test]
    fn test_state_color_playing() {
        assert_eq!(state_color("playing"), "accent");
    }

    #[test]
    fn test_state_color_unavailable() {
        assert_eq!(state_color("unavailable"), "error");
    }

    #[test]
    fn test_state_color_numeric() {
        assert_eq!(state_color("22.5"), "accent");
    }

    #[test]
    fn test_state_color_unknown_string() {
        assert_eq!(state_color("some_random_state"), "dim");
    }
}
