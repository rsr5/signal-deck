# ⚡ Signal Deck

*The oscilloscope for Home Assistant.*

A Lovelace custom card that embeds a safe Python-like REPL for debugging, observability, and exploring Home Assistant state.

![Phase 1 — MVP Shell](https://img.shields.io/badge/phase-1%20MVP-blue)

---

## Features (Phase 1)

- 🖥️ Terminal-style REPL inside your dashboard
- 🔍 Magic commands: `%ls`, `%get`, `%find` to explore entities
- ⚡ Rust shell engine compiled to WASM (100KB)
- 🎨 Dark terminal aesthetic (Iosevka Nerd Font)
- 📋 Session history with arrow key navigation
- 🔒 Read-only — no service calls without explicit arming

---

## Installation

### HACS (coming soon)

Signal Deck will be available as a HACS custom repository.

### Manual Installation

1. Download `signal-deck.js` and `signal_deck_engine_bg.wasm` from the [latest release](https://github.com/your-username/signal-deck/releases)
2. Copy both files to your HA `config/www/` directory
3. Add the resource in HA:

   **Settings → Dashboards → ⋮ (top right) → Resources → Add Resource**

   ```
   URL: /local/signal-deck.js
   Type: JavaScript Module
   ```

4. Add the card to a dashboard:

   ```yaml
   type: custom:signal-deck
   title: Signal Deck
   height: 400px
   ```

---

## Development

### Prerequisites

- Node.js ≥ 20
- Rust + `wasm32-unknown-unknown` target
- wasm-pack (`cargo install wasm-pack`)

### Setup

```bash
git clone https://github.com/your-username/signal-deck.git
cd signal-deck
npm install
```

### Build

```bash
# Build everything (Rust WASM + TypeScript bundle)
npm run build

# Or build separately:
npm run build:wasm   # Rust → WASM
npm run build:ts     # TypeScript → JS bundle
```

### Dev Mode

```bash
npm run dev
```

This starts a dev server on `http://localhost:5050` with:
- Live rebuild on TypeScript changes
- CORS headers enabled for HA dev access
- Dev preview page at `http://localhost:5050/`

#### Using with Home Assistant (dev mode)

To test against a real HA instance during development:

1. Start the dev server: `npm run dev`
2. In HA, add a resource pointing to your dev server:

   **Settings → Dashboards → Resources → Add Resource**

   ```
   URL: http://YOUR_DEV_MACHINE_IP:5050/signal-deck.js
   Type: JavaScript Module
   ```

3. Add the card to a dashboard:

   ```yaml
   type: custom:signal-deck
   title: Signal Deck (dev)
   ```

4. Changes rebuild automatically — refresh the HA page to pick them up.

> **Note:** Replace `YOUR_DEV_MACHINE_IP` with your actual machine's IP address
> (not `localhost` — HA runs in a different context).

### Tests

```bash
# TypeScript tests
npm test

# Rust tests
npm run test:rust

# All tests
npm run test:all
```

### Lint & Format

```bash
npm run lint
npm run format
```

---

## Architecture

Signal Deck has three layers:

| Layer | Language | Responsibility |
|-------|----------|---------------|
| **UI + HA Bridge** | TypeScript (Lit Element) | Lovelace card, HA WebSocket, rendering |
| **Shell Engine** | Rust (WASM) | REPL, magics, session state, render specs |
| **Python Runtime** | Monty (WASM) | Sandboxed user snippet execution |

See [`agents.md`](./agents.md) for full architecture rules.

---

## Commands

```
:help              Show help
%ls [domain]       List entities
%get <entity_id>   Show entity state
%find <pattern>    Search entities by glob
%hist <id> [-h N]  Show history (last N hours)
%bundle <name>     Run a named bundle
%fmt <format>      Set output format
```

---

## License

MIT
