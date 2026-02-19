# Contributing to Signal Deck

Thanks for your interest in contributing! Signal Deck is an open source project and we welcome contributions of all kinds — bug reports, feature requests, documentation improvements, and code.

## Getting Started

### Prerequisites

- **Rust** (stable toolchain) — [install](https://rustup.rs/)
- **wasm-pack** — `cargo install wasm-pack`
- **Node.js** >= 18 + npm
- A **Home Assistant** instance for testing

### Building

```bash
# Clone the repo
git clone https://github.com/rsr5/signal-deck.git
cd signal-deck

# Install JS dependencies
npm install

# Build everything (WASM + TypeScript)
npm run build

# Or build each layer separately:
npm run build:wasm    # Rust → WASM
npm run build:ts      # TypeScript → Rollup bundle
```

### Running Tests

```bash
# All tests
npm run test:all

# Rust tests only (144 tests)
npm run test:rust

# TypeScript tests only (19 tests)
npm run test

# Watch mode
npm run test:watch
```

### Dev Mode

```bash
# Watch mode — rebuilds on file changes
npm run dev
```

Copy `dist/signal-deck.js` to your HA `config/www/` folder and add it as a Lovelace resource to test.

## Architecture — The Three-Layer Rule

Signal Deck has **strict architectural boundaries**. Before writing code, understand which layer your change belongs in:

```
┌──────────────────────────────────────────────────┐
│  TypeScript (Lit Element)                        │
│  HA WebSocket · UI rendering · Auth · Security   │
├──────────────────────────────────────────────────┤
│  Rust Shell Engine (WASM)                        │
│  REPL state · Parsing · Magics · Render specs    │
├──────────────────────────────────────────────────┤
│  Monty (Python runtime, sandboxed)               │
│  Executes user Python snippets only              │
└──────────────────────────────────────────────────┘
```

### What goes where

| Change | Layer |
|--------|-------|
| New Python API function (`ls()`, `events()`, etc.) | **Rust** — implement in shell engine |
| New magic command (`%something`) | **Rust** — `crates/shell-engine/src/magic.rs` |
| New render spec type (card, chart, etc.) | **Rust** generates it, **TypeScript** renders it |
| HA WebSocket calls | **TypeScript** only — Rust never talks to HA directly |
| UI components | **TypeScript** — Lit Element components |
| REPL parsing / history / state | **Rust** — never in TypeScript |

### Rules

- **Rust MUST NOT** talk to HA directly (no WebSocket access)
- **Monty MUST NOT** implement REPL logic, magics, or widgets
- **TypeScript MUST NOT** implement command parsing or data transforms
- **Auth tokens never reach WASM** — security lives entirely in TypeScript

## Submitting Changes

### Pull Requests

1. **Fork** the repository and create your branch from `main`
2. **Write tests** for any new functionality
3. **Run the full test suite** before submitting: `npm run test:all`
4. **Lint your code**: `npm run lint` (TS) and `cargo clippy` (Rust)
5. **Format your code**: `npm run format` (TS) and `cargo fmt` (Rust)
6. Write a clear PR description explaining what and why

### Checklist

When adding or changing features, make sure to update:

- [ ] **`:help` text** in `crates/shell-engine/src/magic.rs` → `help_text()` — if you added/removed a Python API function, magic command, or keyboard shortcut
- [ ] **AI analyst system prompt** in `src/assistant/analyst-session.ts` — if you added a new Python API function (but read the caution below)
- [ ] **Documentation** in `docs/index.html` and `README.md`
- [ ] **Tests** — Rust tests in `crates/shell-engine/src/` and/or TypeScript tests in `src/`

### ⚠️ System Prompt Caution

The AI analyst system prompt (`src/assistant/analyst-session.ts`) is **carefully tuned for small local LLMs** (≤8B parameters). Every word matters. Before changing it:

1. Discuss the problem first — open an issue or PR draft
2. Consider whether the fix belongs in the prompt vs. the agent loop code vs. the rendering layer
3. Small models learn by example, not by rules — prefer adding a worked example over adding a rule
4. Never mention tools or APIs you want the model to *avoid*
5. Test with an actual small model before considering the change done

## Reporting Bugs

Open an issue on [GitHub Issues](https://github.com/rsr5/signal-deck/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your HA version and browser
- Any console errors

## Code Style

- **TypeScript**: ESLint + Prettier (enforced via `npm run lint` / `npm run format`)
- **Rust**: rustfmt + clippy (enforced via `cargo fmt` / `cargo clippy`)
- Prefer clarity over cleverness
- Keep the API minimal — every new function is a maintenance commitment

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
