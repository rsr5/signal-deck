# Changelog

All notable changes to Signal Deck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.1] — 2025-06-15

### Added

- **Python REPL** — Full Python interpreter via [Monty](https://github.com/pydantic/monty) (Pydantic WASM runtime)
- **Rust shell engine** — Command parsing, magic commands, auto-resolve, session history, output shaping
- **Magic commands** — `:help`, `:clear`, `%ls`, `%get`, `%find`, `%hist`, `%attrs`, `%diff`, `%bundle`, `%fmt`, `%ask`
- **Auto-resolve** — Type entity IDs or domain names directly as shortcuts
- **Python API — State & Entities** — `state()`, `states()`, `entities()`, `devices()`
- **Python API — History & Diagnostics** — `history()`, `statistics()`, `logbook()`, `traces()`, `error_log()`, `check_config()`
- **Python API — Calendar Events** — `events()` with `CalendarEvent` dataclass and rich date-grouped rendering
- **Python API — Rooms & Services** — `room()`, `rooms()`, `services()`, `call_service()` (with confirmation gate)
- **Python API — Utilities** — `show()`, `now()`, `ago()`, `template()`
- **Python API — Charts** — `plot_line()`, `plot_bar()`, `plot_pie()`, `plot_series()` with multi-series support
- **ECharts visualisations** — Inline charts auto-themed to Signal Deck's dark aesthetic
- **AI Signal Analyst** — Built-in AI assistant with iterative code execution loop via HA Conversation
- **Embedded mode** — Standard inline Lovelace card
- **Overlay mode** — Quake-style drop-down console with backtick toggle
- **Entity card renderers** — Rich display for common entity types (sensors, lights, calendars, etc.)
- **Rich auto-render** — History, traces, logbook, statistics, events, and errors auto-format into rich views
- **Keyboard shortcuts** — Backtick toggle, Escape close, arrow key history navigation
- **Copy output** — Click-to-copy on REPL output blocks
- **HACS compatible** — Installable via HACS custom repository
- **Safe by default** — Sandboxed WASM execution, read-only state access, gated service calls
- **Cache busting** — Content-hash query params for reliable WASM updates

[Unreleased]: https://github.com/rsr5/signal-deck/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/rsr5/signal-deck/releases/tag/v0.1.0-alpha.1
