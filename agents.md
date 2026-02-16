# agents.md — Signal Deck Project Guidance

This file explains the **intent, philosophy, architecture, and rules** of the Signal Deck project for human and AI contributors.

If you are an LLM agent, **read this entire file before writing any code.**

For the phased implementation plan see:

👉 **`ha_python_shell_plan.md`**

---

# Project Name

**Signal Deck**

*The oscilloscope for Home Assistant.*

Signal Deck is a **Home Assistant Lovelace card** that embeds a safe Python-like REPL (via WASM) to explore, debug, and visualise Home Assistant state.

Inspired by: Jupyter notebooks · ipywidgets · observability dashboards · retro terminal tools · Robin Ridler's Home Assistant observability work.

---

# What Signal Deck IS

• A safe Python shell inside Lovelace
• A debugging and observability tool
• A way for LLMs to generate snippets you can run
• A rich display system for HA state
• A mini-automation control surface (safe + gated)
• An event-driven diagnostics instrument

It should feel like: an oscilloscope · a notebook · a debugging console · an observability dashboard.

---

# What Signal Deck is NOT

• Remote code execution
• A full automation engine
• A backend integration
• A replacement for HA automations
• A generic Python environment
• An IPython reimplementation

Safety and clarity are more important than power.

---

# Architecture — Three Layers

Signal Deck has three distinct layers. **Respect these boundaries.**

```
┌─────────────────────────────────────────────────┐
│  TypeScript (Lit Element)                       │
│  Lovelace card · HA WebSocket bridge · UI       │
│  rendering · event subscriptions · scheduling   │
│  orchestration · HACS packaging                 │
├─────────────────────────────────────────────────┤
│  Rust Shell Engine (compiled to WASM)           │
│  REPL state · command parsing · magics ·        │
│  session history · output shaping · render-spec │
│  generation · data transforms · bundles         │
├─────────────────────────────────────────────────┤
│  Monty (Python runtime, sandboxed)              │
│  Executes user Python snippets only             │
│  Called by Rust · no direct HA access            │
└─────────────────────────────────────────────────┘
```

### Monty is a runtime, not the shell

We do **not** implement an IPython-like environment inside Monty.

- **Rust implements the shell experience**: parsing, magics, session state, formatting, render-spec generation, and fast data transforms.
- **Monty is used as the sandboxed interpreter** for executing user Python snippets under policy.
- **TypeScript owns HA I/O + UI rendering** and exposes a small host ABI to Rust/WASM.

**Rule: Monty executes code. Rust decides how the REPL behaves.**

### Rust Shell Engine — responsibilities

Rust MUST implement:

- Command parsing: `:help`, `%bundle`, `%ls`, `%get`, `%hist`, `%fmt`, etc.
- Session state: history, variables, slots, last outputs
- Output shaping: tables, ASCII timelines, render specs (JSON)
- Data transforms: downsampling, lane packing, diffs, correlation helpers
- Bundle loading and execution orchestration
- A stable host ABI: "give me states/history → I return a render spec"

Rust MUST NOT:

- Talk to HA directly (no WebSocket access)
- Render DOM
- Maintain browser subscriptions
- Handle Lovelace lifecycle

### Monty — responsibilities

Monty is used by Rust for:

- Running user code snippets in a constrained interpreter
- Calling a tiny set of host-exposed functions (`ha.state`, `ha.history`, `ui.entity`, `show`)

Monty is NOT responsible for:

- Notebook behaviour
- Magics
- Widgets
- Display logic
- Scheduling

### TypeScript — responsibilities

TypeScript MUST:

- Provide host functions: `host_get_states`, `host_get_history`, `host_call_service` (gated)
- Render the render-spec tree returned by Rust
- Manage Lovelace lifecycle and card configuration
- Provide event streams as inputs to the shell engine
- Handle HACS packaging, card editor UI, and user-facing config

TypeScript MUST NOT:

- Implement REPL logic, magics, or command parsing
- Transform or shape data (that's Rust's job)
- Execute Python (that's Monty's job)

### The ABI boundary

The interface between TS and Rust is **pure data**:

- **Input →** config + HA state snapshots + events + user input
- **Output ←** render-spec tree + host call requests (queries)

Example flow:

1. User types `ha.history("sensor.temp", ha.ago("6h"))`
2. Rust parses → determines it needs history data → returns a host call request
3. TS fetches history via WebSocket → passes raw data back to Rust
4. Rust processes → returns `{"type": "echarts", "option": {...}}`
5. TS renders the ECharts spec

Security and HA auth live **entirely in TypeScript**.

---

# Tech Stack

- **Language**: TypeScript (Lit Element) + Rust (wasm-pack) + Monty (WASM)
- **Build**: Rollup (card bundle) + Cargo (Rust/WASM)
- **Test**: Vitest (TS unit tests) + Cargo test (Rust)
- **Lint/Format**: ESLint + Prettier (TS) · rustfmt + clippy (Rust)
- **Distribution**: HACS custom repository
- **Target**: Home Assistant Lovelace (modern browsers, no backend)

---

# Core Design Principles

1. **Safe by default** — Read-only state access · service calls require `ha.arm()` · no filesystem or network access
2. **Small, opinionated API** — `ha.*` for state/history · `ui.*` for display · magics for shortcuts
3. **LLM-friendly output** — Tables · JSON · ASCII timelines · copy-paste debug reports
4. **Observability first** — Explain why things changed · correlate signals · prefer signals over booleans
5. **Declarative configuration** — Startup scripts · scheduled snippets · event-triggered snippets · bundles
6. **Runs entirely in Lovelace** — HA WebSocket API · no backend required
7. **Clear layer boundaries** — Rust owns logic · Monty owns execution · TS owns I/O and rendering

---

# Visual Style

Signal Deck should feel **awesome and nerdy**.

- **Iosevka Nerd Font** (primary font)
- Monospace layouts · Nerd Font glyphs
- Coloured terminal-style output
- ASCII tables and timelines
- Dense observability dashboards

Think: htop · retro oscilloscope · Winamp visualiser · network monitoring consoles.

The UI should make engineers smile.

---

# Development Phases

1. MVP shell (card skeleton + Rust engine + Monty bridge + basic `ha.*`)
2. Rich display (`ui.entity` · `ui.table` · auto-render · copy output)
3. History + ECharts (`ha.history` · `ha.statistics` · `ui.ts` · binary sensor lanes)
4. Events & scheduling (startup scripts · `watch_state` · `watch_events` · slots)
5. Widgets (widget spec · reactive rerun · arm + confirm service calls)
6. Debugging toolkit (bundles DSL · explain-flip · correlation · trace recording)
7. Packaging (docs · examples · HACS · lazy WASM loading · card editor)
8. Copilot panel (Claude-first · HA Conversation · agent loop · `markdown_agent` patterns)

See full plan: 👉 **`ha_python_shell_plan.md`**

---

# Behaviour Guidelines for Agents

When contributing:

- Prefer clarity over cleverness
- Keep API minimal
- Add safety checks
- Respect the three-layer architecture — do not leak responsibilities across boundaries
- Make output readable in tables with monospace formatting
- Use Nerd Font icons where helpful
- Do not add backend dependencies unless explicitly requested
- Do not expand scope into full automation engine
- Do not implement REPL logic in Monty or TypeScript — that belongs in Rust
- Do not give Monty or Rust direct HA WebSocket access — that belongs in TypeScript
- **When adding or removing a Python API function, magic command, card config option, or keyboard shortcut, update the `:help` text in `crates/shell-engine/src/magic.rs` → `help_text()`**
- **When adding a new Python API function, also update the system prompt in `src/assistant/analyst-session.ts` so the AI analyst knows about it**
- **DO NOT casually edit the system prompt in `src/assistant/analyst-session.ts`.** The system prompt is carefully tuned for small local LLMs (≤8B parameters) that run via HA Conversation. Every word matters — phrasing, structure, example ordering, and what is *not* said are all deliberate. Before changing the prompt:
  1. Discuss the problem you're trying to solve and why a prompt change is needed.
  2. Consider whether the fix belongs in the prompt vs. the agent loop code vs. the rendering layer.
  3. Small models learn by example, not by rules — prefer adding a worked example over adding a rule.
  4. Never mention tools, capabilities, or APIs you want the model to *avoid* — it teaches the model they exist.
  5. Test with an actual small model before considering the change done.

When unsure, optimise for:

👉 debugging presence logic
👉 understanding "why did this happen?"

These are the primary user needs.

---

# Tone

Signal Deck should feel like: a professional engineering instrument · fun and nerdy · deeply technical · precise and explainable.

It is part of a broader ecosystem of observability work (Accumulator, dashboards, etc.).

---

# End
