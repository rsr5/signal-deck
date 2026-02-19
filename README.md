<div align="center">

# 📡 Signal Deck

### The oscilloscope for Home Assistant

A safe Python REPL embedded in Lovelace — with built-in AI analyst,
ECharts visualisations, and deep state exploration.
All running entirely in your browser.

[![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange?style=flat-square)](https://hacs.xyz)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2024.1+-blue?style=flat-square)](https://www.home-assistant.io)
[![Alpha](https://img.shields.io/badge/status-alpha-red?style=flat-square)](#)

<!-- 🖼️ HERO SCREENSHOT — replace with an actual screenshot or screencast -->
<!-- Recommended: 1200×800 or a GIF/MP4 screencast showing the REPL in action -->
<img src="docs/images/hero.png" alt="Signal Deck — Python REPL for Home Assistant" width="900" />

[**Documentation**](https://rsr5.github.io/signal-deck) · [**Install**](#installation) · [**Quick Start**](#quick-start) · [**API Reference**](#python-api)

</div>

---

## What is Signal Deck?

Signal Deck is a **custom Lovelace card** that gives you a sandboxed Python shell right inside Home Assistant. It's built for power users who want to explore entity state, debug automations, visualise history data, and ask an AI analyst questions about their home — all without leaving the dashboard.

Built on [**Monty**](https://github.com/pydantic/monty) (Pydantic's Python-in-WASM runtime) and a custom **Rust shell engine** compiled to WebAssembly.

## ✨ Features

<table>
<tr>
<td width="50%">

**🐍 Python REPL**
Full Python interpreter running in WebAssembly. No backend, no server, no add-on.

**🤖 AI Signal Analyst**
Built-in AI assistant that writes and executes Python against your live HA state. Powered by HA Conversation — works with Claude, Ollama, and local models.

**📊 ECharts Visualisations**
Line, bar, pie, and time-series charts with one function call. Auto-themed to match Signal Deck's dark aesthetic.

</td>
<td width="50%">

**🔍 Deep State Explorer**
Magic commands to search, compare, and inspect entities — attributes, history, diffs, traces, logbooks, calendar events, and more.

**🔒 Safe by Default**
Read-only state access. Service calls require explicit confirmation. No filesystem or network access. Everything sandboxed in WASM.

**🖥️ Overlay Mode**
A Quake-style drop-down console that stays hidden until you need it. Toggle with backtick.

</td>
</tr>
</table>

<!-- 🖼️ FEATURE SCREENSHOTS — add screenshots showing key features -->
<!-- Suggestion: 2-3 screenshots in a row showing REPL, AI analyst, and charts -->
<!--
<p align="center">
  <img src="docs/images/repl.png" width="30%" alt="REPL" />
  <img src="docs/images/analyst.png" width="30%" alt="AI Analyst" />
  <img src="docs/images/charts.png" width="30%" alt="Charts" />
</p>
-->

## Installation

### HACS (Recommended)

1. Open **HACS** in Home Assistant
2. Click ⋮ → **Custom repositories**
3. Add `https://github.com/rsr5/signal-deck` → Category: **Lovelace**
4. Find **Signal Deck** and install
5. **Restart Home Assistant**

### Manual

1. Download `signal-deck.js` from the [latest release](https://github.com/rsr5/signal-deck/releases)
2. Copy to `/config/www/signal-deck/signal-deck.js`
3. Add the resource in **Settings → Dashboards → Resources**:

```yaml
url: /local/signal-deck/signal-deck.js
type: module
```

## Quick Start

Add Signal Deck to any Lovelace dashboard:

```yaml
type: custom:signal-deck
title: Signal Deck
```

Then try these commands:

```python
# Check entity state
state("sensor.living_room_temperature")

# List all lights
states("light")

# See 12 hours of history
history("sensor.power_consumption", 12)

# Search for entities
%find *occupied*

# Ask the AI analyst
%ask why is the kitchen light on?
```

<!-- 🖼️ QUICK START SCREENSHOT — replace with screenshot showing REPL with example output -->
<!-- <img src="docs/images/quick-start.png" alt="Quick Start" width="700" /> -->

## Card Configuration

```yaml
type: custom:signal-deck
title: My Shell           # Card title (optional)
height: 600px             # Card height (optional)
mode: overlay             # "embedded" (default) or "overlay"
overlay_position: top     # "top", "bottom", or "full"
overlay_height: 50vh      # Height when top/bottom
show_analyst: true        # Show AI analyst tab
agent_id: conversation.claude_sonnet  # Pin a specific LLM agent
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `title` | string | — | Card title |
| `height` | string | auto | Card height (CSS value) |
| `mode` | string | `"embedded"` | `"embedded"` or `"overlay"` |
| `overlay_position` | string | `"top"` | `"top"` · `"bottom"` · `"full"` |
| `overlay_height` | string | `"50vh"` | Overlay panel height |
| `show_analyst` | boolean | `true` | Show the AI analyst tab |
| `agent_id` | string | auto | HA Conversation agent ID |

## Python API

All functions are top-level — no imports needed.

### State & Entities

| Function | Description |
|----------|-------------|
| `state(id)` | Entity state as `EntityState` dataclass |
| `states([domain])` | List states, optionally by domain |
| `entities(id)` | Entity registry entry (integration, device, platform) |
| `devices([query])` | List or search devices |

### History & Diagnostics

| Function | Description |
|----------|-------------|
| `history(id, [hours])` | Entity history (default 6h) |
| `statistics(id, [hours], [period])` | Long-term statistics |
| `events(id, [hours])` | Calendar events (default 14 days forward) |
| `logbook([id], [hours])` | Logbook entries |
| `traces([automation_id])` | Automation/script traces |
| `error_log()` | HA error log |
| `check_config()` | Validate HA configuration |

### Rooms & Services

| Function | Description |
|----------|-------------|
| `room(name)` | All entities in an area/room |
| `rooms()` | List all areas/rooms |
| `services([domain])` | List available services |
| `call_service(d, s, {})` | Call a HA service (requires confirmation) |

### Utilities

| Function | Description |
|----------|-------------|
| `show(value)` | Pretty-print any value |
| `now()` | Current date/time |
| `ago(spec)` | Relative time — `ago("6h")`, `ago("2d")` |
| `template(tpl)` | Render a Jinja2 template |

### Charts (ECharts)

| Function | Description |
|----------|-------------|
| `plot_line(labels, values, [title])` | Line chart |
| `plot_bar(labels, values, [title])` | Bar chart |
| `plot_pie(data, [title])` | Pie chart (`{"name": value}`) |
| `plot_series(points, [title])` | XY / time-series chart |

Multi-series: pass `{"Series A": [...], "Series B": [...]}` as values.
Time axes auto-detected from epoch-ms x values.

<!-- 🖼️ CHARTS SCREENSHOT — replace with screenshot showing a chart rendered in Signal Deck -->
<!-- <img src="docs/images/charts-example.png" alt="Charts" width="700" /> -->

### Magic Commands

| Command | Description |
|---------|-------------|
| `:help` | Show help reference |
| `:clear` | Clear output |
| `%ls [domain]` | List entities |
| `%get <id>` | Show entity state |
| `%find <pattern>` | Search entities by glob |
| `%hist <id> [-h N]` | Show history (last N hours) |
| `%attrs <id>` | Show all entity attributes |
| `%diff <id1> <id2>` | Compare two entities |
| `%bundle <name>` | Run a named bundle |
| `%fmt <format>` | Set output format (`table` · `json` · `text`) |
| `%ask <question>` | Ask the AI analyst |

### Auto-resolve

Type entity IDs or domain names directly — Signal Deck resolves them:

```python
sensor.living_room_temperature  # → %get sensor.living_room_temperature
light                           # → %ls light
```

## AI Signal Analyst

The built-in AI analyst connects to your **HA Conversation** integration. It writes and executes Python code against your live state in an iterative loop — write code, see results, continue until it can answer.

```python
%ask which rooms are currently occupied?
%ask why did the kitchen light turn on at 3am?
%ask show me power consumption over the last 24 hours
%ask compare indoor and outdoor temperature
%ask chart the agile electricity prices
```

Works with Claude, GPT, Ollama, and any HA Conversation agent. The system prompt is tuned for small local models (≤ 8B).

<!-- 🖼️ AI ANALYST SCREENSHOT — replace with screenshot showing analyst answering a question -->
<!-- <img src="docs/images/analyst.png" alt="AI Signal Analyst" width="700" /> -->

## Architecture

Signal Deck uses a **three-layer architecture** with strict boundaries:

```
┌─────────────────────────────────────────────────────┐
│  TypeScript (Lit Element)                           │
│  Lovelace card · HA WebSocket · UI rendering        │
├─────────────────────────────────────────────────────┤
│  Rust Shell Engine (WASM)                           │
│  REPL · magics · session state · render specs       │
├─────────────────────────────────────────────────────┤
│  Monty Python Runtime (WASM · sandboxed)            │
│  Executes user Python snippets · no direct HA I/O   │
└─────────────────────────────────────────────────────┘
```

| Layer | Responsibility |
|-------|---------------|
| **TypeScript** | HA WebSocket bridge, DOM rendering, Lovelace lifecycle, auth |
| **Rust (WASM)** | Command parsing, magics, session state, output shaping, charts |
| **Monty (WASM)** | Sandboxed execution of user Python code |

**Security:** Python runs in WebAssembly — no filesystem, no network, no system access. All HA data fetched via WebSocket by TypeScript. Service calls require explicit user confirmation.

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- [Node.js](https://nodejs.org/) ≥ 18

### Build

```bash
git clone https://github.com/rsr5/signal-deck.git
cd signal-deck
npm install

npm run build:wasm    # Rust → WASM
npm run build:ts      # TypeScript → JS bundle
npm run build         # Both
```

### Dev Mode

```bash
npm run dev           # Rollup dev server on localhost:5050
```

Point HA to `http://YOUR_DEV_IP:5050/signal-deck.js` as a resource.

### Tests

```bash
cargo test            # Rust tests (144 tests)
npx vitest run        # TypeScript tests (19 tests)
npm run test:all      # Both
```

### Project Structure

```
signal-deck/
├── crates/shell-engine/     # Rust shell engine → WASM
│   └── src/
│       ├── engine.rs        # Core REPL engine + chart builders
│       ├── magic.rs         # Magic command parser + help text
│       ├── monty_runtime.rs # Monty Python integration
│       └── render.rs        # Render spec types
├── src/
│   ├── signal-deck.ts       # Main Lit Element card
│   ├── assistant/           # AI analyst agent loop
│   ├── components/          # Entity card renderers
│   ├── engine/              # WASM bridge
│   ├── host/                # HA WebSocket host functions
│   └── types/               # TypeScript types
├── docs/                    # Documentation site
├── dist/                    # Built card bundle
└── pkg/                     # WASM build output
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contributor guide and [`agents.md`](agents.md) for architecture rules.

## License

[MIT](LICENSE) © 2025 [Robin Ridler](https://github.com/rsr5)

---

<div align="center">

**[📖 Documentation](https://rsr5.github.io/signal-deck)** · **[🐛 Report Bug](https://github.com/rsr5/signal-deck/issues)** · **[💡 Request Feature](https://github.com/rsr5/signal-deck/issues)**

Made with 🧡 for the Home Assistant community

</div>
