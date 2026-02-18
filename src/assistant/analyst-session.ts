/**
 * AnalystSession — the Signal Analyst agent loop.
 *
 * Follows the markdown_agent pattern:
 * 1. User asks a question
 * 2. Context + question sent to HA Conversation → LLM responds with markdown
 * 3. Parser extracts ```signal-deck code blocks
 * 4. Each block is executed via the shared ShellEngine
 * 5. Results injected as ```result blocks in the document
 * 6. Updated document sent back to LLM (new turn)
 * 7. Loop until no executable blocks remain (done)
 *
 * The session shares the same ShellEngine as the user's REPL,
 * so the analyst has the same Python context (variables, history).
 *
 * Two execution modes:
 * - "background": results only appear in the analyst panel
 * - "shell": output also appears in the user's REPL (as if they typed it)
 */

import type { ShellEngine } from '../engine/wasm-bridge.js';
import type { HomeAssistant, RenderSpec } from '../types/index.js';
import { fulfillHostCall, isHostCall } from '../host/host-functions.js';
import {
  parse,
  getText,
  getExecutableBlocks,
  injectResult,
  isCommentOnly,
} from './parser.js';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Types of events the analyst loop emits. */
export type AnalystEventType =
  | 'thinking'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'code_running'
  | 'code_result'
  | 'error'
  | 'done'
  | 'max_iterations';

/** A single event emitted during the agent loop. */
export interface AnalystEvent {
  type: AnalystEventType;
  iteration: number;
  /** LLM prose or status message. */
  text?: string;
  /** The full markdown document at this point. */
  document?: string;
  /** Code block being executed. */
  code?: string;
  /** Execution result text. */
  result?: string;
  /** RenderSpec from engine (for shell-mode display). */
  spec?: RenderSpec;
  /** True if this is an intermediate message (more iterations to come). */
  intermediate?: boolean;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Signal Analyst — a terse, technical Python REPL agent inside Signal Deck, a Home Assistant debugging shell.

You interact with Home Assistant ONLY by writing Python code in \`\`\`signal-deck blocks.
After each block runs, the result appears in a \`\`\`result block (never write result blocks yourself).
Anything outside a code block is just commentary — only code blocks do things.

STOP RULE: Once you have the data to answer the user's question, give a SHORT plain-text answer (1-3 sentences) with NO code block. That ends the turn. Do NOT run extra queries, do NOT explore unrelated entities, do NOT add encouragement or praise. Just answer and stop.

Here are complete worked examples. Study them — they show exactly how to work.

EXAMPLE 1 — "Are any lights on?"

\`\`\`signal-deck
lights = states("light")
on = [e for e in lights if e.state == "on"]
show(on)
\`\`\`

EXAMPLE 2 — "Show me the living room temperature history"

First, find the entity (never guess IDs — always search):

\`\`\`signal-deck
matches = [e for e in states("sensor") if "temp" in e.entity_id and "living" in e.entity_id]
show(matches)
\`\`\`

Then use the entity_id from the result:

\`\`\`signal-deck
history(matches[0].entity_id, ago("6h"))
\`\`\`

To get a single entity from a list, always use list + index: matches[0]
Never use next() or generator expressions — they are not supported.

EXAMPLE 3 — "Turn off the kitchen light"

Search first, then call_service with the exact entity_id:

\`\`\`signal-deck
matches = [e for e in states("light") if "kitchen" in e.entity_id or "kitchen" in e.name.lower()]
show(matches)
\`\`\`

\`\`\`signal-deck
call_service("light", "turn_off", {"entity_id": matches[0].entity_id})
\`\`\`

The user sees a confirmation card and must click ✓ before anything happens.

EXAMPLE 4 — "Why did the front door sensor trigger?"

\`\`\`signal-deck
logbook("binary_sensor.front_door", ago("24h"))
\`\`\`

EXAMPLE 5 — "What's the next waste collection?" or any calendar question

Calendar entities only show one event in state(). Use events() to see all upcoming events:

\`\`\`signal-deck
events("calendar.my_calendar")
\`\`\`

EXAMPLE 6 — "What's happening in the bedroom?"

\`\`\`signal-deck
room("bedroom")
\`\`\`

EXAMPLE 7 — "What sensors are in the kitchen?"

\`\`\`signal-deck
matches = [e for e in states("sensor") if "kitchen" in e.entity_id or "kitchen" in e.name.lower()]
show(matches)
\`\`\`

If no results, try different words, or search ALL domains with states() (no argument) instead of just one.
Always use words the user actually said — they know their own device names.

EXAMPLE 8 — What a good final answer looks like:

After running code and getting results, reply like this (plain text, no code block):

"3 lights are currently on: light.kitchen (100%), light.hallway (50%), and light.porch (100%). Logbook shows light.hallway was turned on at 14:20 by automation.motion_hallway."

Notice: cites entity IDs and actual state values. No guessing. No "I believe" or "it appears." Just data.

EXAMPLE 9 — "How much energy did I use today?"

When results contain numeric data, use a chart — users prefer visual answers.
Pick the right chart type:
  - plot_pie: "how many of each", proportions, breakdowns, distribution across categories
  - plot_bar: comparing values side by side, rankings, top-N lists
  - plot_line: trends across ordered categories (hours of day, days of week)
  - plot_series: time-series history data with timestamps, [(epoch_ms, value), ...]

Example — breakdown by category → pie chart:

\`\`\`signal-deck
all = states()
domains = {}
for e in all:
    domains[e.domain] = domains.get(e.domain, 0) + 1
plot_pie(domains, "Entities by Domain")
\`\`\`

Example — comparing values → bar chart:

\`\`\`signal-deck
sensors = [e for e in states("sensor") if "energy" in e.entity_id and e.state not in ("unknown","unavailable")]
labels = [e.name for e in sensors]
values = [float(e.state) for e in sensors]
plot_bar(labels, values, "Energy Usage (kWh)")
\`\`\`

─────────────────────────────────────────────────────────────────────

PYTHON API REFERENCE:

State & Entities:
  state("entity_id")                → single EntityState (rich display)
  states()                          → all entities (use filters!)
  states("domain")                  → entities in a domain
  entities("entity_id")             → registry entry (integration, device, platform)
  devices() / devices("keyword")    → list/search devices

History & Diagnostics (call as bare expressions — they auto-render rich displays):
  history("entity_id", hours)       → sparkline or timeline (auto-detected)
  statistics("entity_id", hours, period) → long-term stats ("5minute"/"hour"/"day")
  events("calendar.entity_id")      → upcoming calendar events (next 14 days)
  logbook("entity_id", hours)       → who/what changed this entity and why
  traces("automation.xyz")          → automation trace (trigger, steps, errors)
  traces()                          → recent traces across all automations
  check_config()                    → validate HA YAML configuration
  error_log()                       → recent HA error log
  Do NOT wrap these in show() — just call them directly as the last line.

Rooms & Services:
  room("Living Room")               → all entities in an area
  rooms()                           → list all areas
  services() / services("domain")   → list available services
  call_service("domain", "svc", {}) → call a service (user confirms first)

Utilities:
  show(value)                       → pretty-print any value
  now()                             → current date/time/timezone
  ago("6h") / ago("2d") / ago("1w") → hours as integer (6, 48, 168)
  template("{{ states('sensor.x') }}") → render Jinja2 template

Charts (interactive ECharts):
  plot_line(labels, values, title?)   → line chart
  plot_bar(labels, values, title?)    → bar chart
  plot_pie(data_dict, title?)         → pie chart
  plot_series(points, title?)         → XY / time-series line chart
  Multi-series: plot_line(labels, {"A": [...], "B": [...]}, title)
  Series data:  plot_series([(x,y),...]) or {"A": [(x,y),...], ...}
  Time axis auto-detected from epoch-ms x values.

EntityState fields: .entity_id .state .name .domain .device_class .unit .last_changed .attributes

─────────────────────────────────────────────────────────────────────

RULES (few but important):
  - NEVER guess entity IDs. Always search with states() + filter first.
  - ALL service calls go through call_service() in a code block.
  - Be terse. No filler, no praise, no encouragement. State facts, cite data, stop.
  - Once you have the answer, reply in plain text with NO code block. That ends your turn.
  - If a search returns nothing, try states() with NO domain and just the keyword. NEVER give up after one empty search. NEVER invent entities.
  - If a search returns too many results, FILTER with more specific keywords from the user's question.
  - If code errors, read the traceback, fix the code, and try again. NEVER guess the answer after an error.
  - Never use next() — use list comprehension + [0] indexing instead.
  - Only state what the data shows. Say "sensor X reports Y" — never interpret what a state means.
  - If the user mentions a brand or device name (e.g. "zappi", "hue", "sonos"), always include that word in your search.
  - Focus on debugging: explain *why* things are the way they are.`;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 6;

/** Configuration for the analyst session. */
export interface AnalystConfig {
  /** Max agent loop iterations before stopping. */
  maxIterations?: number;
  /** Force a specific HA conversation agent ID (e.g. "conversation.claude_opus_conversation"). */
  agentId?: string;
  /** Callback to request user confirmation for a service call.
   *  Returns true if confirmed, false if denied. */
  confirmServiceCall?: (params: Record<string, unknown>) => Promise<boolean>;
}

/**
 * AnalystSession — manages a multi-turn conversation with the LLM
 * and executes code blocks through the shared shell engine.
 */
export class AnalystSession {
  private hass: HomeAssistant;
  private engine: ShellEngine;
  private maxIterations: number;
  private _forcedAgentId: string | undefined;
  private _confirmServiceCall: ((params: Record<string, unknown>) => Promise<boolean>) | undefined;
  private messages: Array<{ role: string; content: string }> = [];
  private _cancelled = false;
  private _prevCode = '';
  private _repeatCount = 0;
  private _initialized = false;

  constructor(hass: HomeAssistant, engine: ShellEngine, config?: AnalystConfig) {
    this.hass = hass;
    this.engine = engine;
    this.maxIterations = config?.maxIterations ?? MAX_ITERATIONS;
    this._forcedAgentId = config?.agentId;
    this._confirmServiceCall = config?.confirmServiceCall;
  }

  /** Update the hass reference (e.g. when HA reconnects). */
  set hassRef(hass: HomeAssistant) {
    this.hass = hass;
  }

  /** Update the service-call confirmation callback. */
  set confirmCallback(cb: ((params: Record<string, unknown>) => Promise<boolean>) | undefined) {
    this._confirmServiceCall = cb;
  }

  /** The resolved conversation agent entity ID (e.g. "conversation.claude_conversation"). */
  get resolvedAgentId(): string | null {
    return this._findConversationAgent();
  }

  /** Cancel a running agent loop. */
  cancel(): void {
    this._cancelled = true;
  }

  /**
   * Run the agent loop for a user question.
   *
   * Yields AnalystEvent objects as the loop progresses.
   * The caller (AnalystPanel) subscribes and updates the UI.
   *
   * @param shellCallback - called when code runs in "shell" mode,
   *   so the main REPL can show the output too.
   */
  async *run(
    userPrompt: string,
    shellCallback?: (input: string, spec: RenderSpec) => void,
  ): AsyncGenerator<AnalystEvent> {
    this._cancelled = false;
    this._prevCode = '';
    this._repeatCount = 0;

    // First call: initialise with the system prompt.
    // Subsequent calls: just append the new user message — the full
    // conversation history is preserved so the LLM has context.
    if (!this._initialized) {
      this.messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ];
      this._initialized = true;
    } else {
      this.messages.push({ role: 'user', content: userPrompt });
    }

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      if (this._cancelled) return;

      // 1. Call LLM
      yield { type: 'thinking', iteration };

      let llmResponse: string;
      try {
        llmResponse = await this._callLLM();
      } catch (e) {
        yield { type: 'error', iteration, text: `LLM error: ${e}` };
        return;
      }

      if (this._cancelled) return;

      // 2. Parse the response
      const doc = parse(llmResponse);
      const executable = getExecutableBlocks(doc).filter(
        (b) => !isCommentOnly(b.code),
      );

      // Show the LLM's message
      // If there are executable blocks, this is intermediate (more iterations coming).
      const isIntermediate = executable.length > 0;
      yield {
        type: 'message',
        iteration,
        text: llmResponse,
        document: getText(doc),
        intermediate: isIntermediate,
      };

      // 3. No executable blocks → done
      if (executable.length === 0) {
        yield { type: 'done', iteration, document: getText(doc) };
        return;
      }

      // 4. Repetition detection
      const currentCode = executable.map((b) => b.code.trim()).join('\n');
      if (currentCode === this._prevCode) {
        this._repeatCount++;
        if (this._repeatCount >= 2) {
          yield {
            type: 'done',
            iteration,
            text: 'Repeated code detected — finishing.',
            document: getText(doc),
          };
          return;
        }
        // Nudge the LLM
        this.messages.push({ role: 'assistant', content: llmResponse });
        this.messages.push({
          role: 'user',
          content:
            'You already ran this exact code and the result is above. ' +
            'Do not repeat it. Give your final answer now using only the results you have.',
        });
        continue;
      }
      this._prevCode = currentCode;
      this._repeatCount = 0;

      // 5. Execute each block
      let updatedDoc = doc;
      let lastBlockErrored = false;
      let lastBlockEmpty = false;
      for (const block of executable) {
        if (this._cancelled) return;

        yield {
          type: 'code_running',
          iteration,
          code: block.code,
        };

        // Execute through the shared engine
        const { output, spec } = await this._executeBlock(block.code);
        lastBlockErrored = spec.type === 'error';
        lastBlockEmpty = this._isEmptyResult(spec, output);

        // If shellCallback provided, also show in the user's REPL
        if (shellCallback) {
          shellCallback(block.code, spec);
        }

        yield {
          type: 'code_result',
          iteration,
          code: block.code,
          result: output,
          spec,
        };

        // Inject result into the document
        updatedDoc = injectResult(updatedDoc, block, output);

        // Re-find the block references since line numbers shifted
        // (injectResult re-parses, so we're fine for the next iteration)
      }

      // 6. Send updated document back to LLM for next turn
      let stopNudge: string;
      if (lastBlockErrored) {
        stopNudge = '\n\n[Code errored. Fix the code and try again. Do NOT guess or make up an answer.]';
      } else if (lastBlockEmpty) {
        stopNudge = '\n\n[Search returned no results. You MUST write another ```signal-deck code block now, searching states() with NO domain. Do NOT answer without data.]';
      } else {
        stopNudge = '\n\n[Results above. If you have enough data to answer, reply with a SHORT plain-text answer and NO code block.]';
      }
      this.messages.push({ role: 'assistant', content: llmResponse });
      this.messages.push({
        role: 'user',
        content: getText(updatedDoc) + stopNudge,
      });
    }

    yield {
      type: 'max_iterations',
      iteration: this.maxIterations,
      text: `Reached max iterations (${this.maxIterations}).`,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Max conversation messages to keep (excluding the system prompt).
   *  Older messages are dropped to keep the context window manageable. */
  private static MAX_HISTORY_MESSAGES = 40;

  /** Call the HA conversation/process API. */
  private async _callLLM(): Promise<string> {
    // Find the best conversation agent
    const agentId = this._findConversationAgent();

    // Trim conversation history if it grows too long.
    // Keep the system prompt (index 0) + the last N messages.
    const maxHistory = AnalystSession.MAX_HISTORY_MESSAGES;
    if (this.messages.length > maxHistory + 1) {
      this.messages = [
        this.messages[0], // system prompt
        ...this.messages.slice(-(maxHistory)),
      ];
    }

    // Build the full message text.
    // HA conversation/process is stateless per-call, so we send the
    // full conversation history concatenated.
    const conversationText = this.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const prefix = m.role === 'user' ? 'User' : 'Assistant';
        return `${prefix}: ${m.content}`;
      })
      .join('\n\n---\n\n');

    // Prepend system prompt to the conversation text
    const fullText = `${this.messages[0].content}\n\n---\n\n${conversationText}`;

    const response = await this.hass.callWS<{
      response: {
        speech: { plain: { speech: string } };
      };
    }>({
      type: 'conversation/process',
      text: fullText,
      ...(agentId ? { agent_id: agentId } : {}),
    });

    return response?.response?.speech?.plain?.speech ?? '(no response)';
  }

  /** Execute a code block through the shared engine, fulfilling any host calls. */
  private async _executeBlock(code: string): Promise<{ output: string; spec: RenderSpec }> {
    let spec = this.engine.eval(code);

    // Fulfill host calls (same loop as signal-deck.ts _submitInput)
    while (isHostCall(spec) && this.hass) {
      // Gate service calls behind user confirmation.
      if (spec.method === 'call_service') {
        if (this._confirmServiceCall) {
          const confirmed = await this._confirmServiceCall(spec.params);
          if (!confirmed) {
            spec = this.engine.fulfillHostCall(
              spec.call_id,
              JSON.stringify({ error: 'Service call cancelled by user' }),
            );
            continue;
          }
        } else {
          // No confirmation callback — deny by default for safety.
          spec = this.engine.fulfillHostCall(
            spec.call_id,
            JSON.stringify({ error: 'Service calls require user confirmation (no callback configured)' }),
          );
          continue;
        }
      }
      const result = await fulfillHostCall(this.hass, spec.method, spec.params);
      spec = this.engine.fulfillHostCall(spec.call_id, result.data);
    }

    // Extract a text representation of the result for injecting into the document
    let output = this._specToText(spec);

    // Append contextual hints so the LLM knows what to do next.
    if (spec.type === 'error') {
      output += '\n[Code failed. Read the error, fix the code, and try again in a new code block. Do NOT guess the answer.]';
    } else if (this._isEmptyResult(spec, output)) {
      output += '\n[Empty result — no entities matched. You MUST write another code block searching states() with NO domain argument. Do NOT answer yet.]';
    }

    return { output, spec };
  }
  /** Check whether a result is empty (no entities found, empty list, etc). */
  private _isEmptyResult(spec: RenderSpec, text: string): boolean {
    if (spec.type === 'text' && (text.trim() === '[]' || text.trim() === '()' || text.trim() === 'None')) return true;
    if (spec.type === 'table' && spec.rows.length === 0) return true;
    if (spec.type === 'vstack' && spec.children.length === 0) return true;
    if (spec.type === 'summary' && /\b0\s+(entit|item|result)/i.test(text)) return true;
    return false;
  }

  /** Max rows to include in text sent back to the LLM. */
  private static MAX_TEXT_ROWS = 20;

  /** Convert a RenderSpec to a plain text string for document injection.
   *  Large results are truncated to keep LLM context small — the full
   *  data is still shown in the shell pane via the RenderSpec. */
  private _specToText(spec: RenderSpec): string {
    switch (spec.type) {
      case 'text':
        return spec.content;
      case 'error':
        return `Error: ${spec.message}`;
      case 'table': {
        const headerLine = spec.headers.join(' | ');
        const total = spec.rows.length;
        const limit = AnalystSession.MAX_TEXT_ROWS;
        const shown = spec.rows.slice(0, limit);
        const rows = shown.map((r) => r.join(' | ')).join('\n');
        if (total > limit) {
          return `${headerLine}\n${rows}\n... (${total - limit} more rows hidden — use slicing or filtering to see more)`;
        }
        return `${headerLine}\n${rows}`;
      }
      case 'entity_card':
        return `${spec.name} (${spec.entity_id}): ${spec.state}${spec.unit ? ' ' + spec.unit : ''}`;
      case 'vstack': {
        const children = spec.children;
        const limit = AnalystSession.MAX_TEXT_ROWS;
        if (children.length > limit) {
          const shown = children.slice(0, limit).map((c) => this._specToText(c)).join('\n');
          return `${shown}\n... (${children.length - limit} more items hidden — use slicing or filtering to see more)`;
        }
        return children.map((c) => this._specToText(c)).join('\n');
      }
      case 'hstack':
        return spec.children.map((c) => this._specToText(c)).join(' ');
      case 'summary':
        return spec.content;
      case 'key_value':
        return spec.pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
      case 'help':
        return spec.content;
      case 'badge':
        return spec.label;
      case 'copyable':
        return spec.content;
      case 'sparkline':
        return `📈 ${spec.name} (${spec.entity_id}): min=${spec.min}${spec.unit ? ' ' + spec.unit : ''}, current=${spec.current}${spec.unit ? ' ' + spec.unit : ''}, max=${spec.max}${spec.unit ? ' ' + spec.unit : ''} (${spec.points.length} points)`;
      case 'timeline': {
        const states = [...new Set(spec.segments.map((s: [number, number, string, string]) => s[2]))];
        return `📊 ${spec.name} (${spec.entity_id}): states=[${states.join(', ')}] (${spec.segments.length} segments)`;
      }
      case 'logbook': {
        const limit = AnalystSession.MAX_TEXT_ROWS;
        const total = spec.entries.length;
        const shown = spec.entries.slice(0, limit);
        const lines = shown.map((e) => {
          const state = e.state ? ` → ${e.state}` : '';
          const ctx = e.context_domain && e.context_service
            ? ` (via ${e.context_domain}.${e.context_service})`
            : e.context_entity_name
              ? ` (by ${e.context_entity_name})`
              : '';
          return `${e.when}: ${e.name}${state}${ctx}`;
        }).join('\n');
        if (total > limit) {
          return `📋 Logbook for ${spec.entity_id} (${total} entries):\n${lines}\n... (${total - limit} more entries hidden)`;
        }
        return `📋 Logbook for ${spec.entity_id} (${total} entries):\n${lines}`;
      }
      case 'trace_list': {
        const limit = AnalystSession.MAX_TEXT_ROWS;
        const total = spec.entries.length;
        const shown = spec.entries.slice(0, limit);
        const header = spec.automation_id
          ? `🔍 Traces for ${spec.automation_id} (${total} runs)`
          : `🔍 ${total} recent automation traces`;
        const lines = shown.map((e) => {
          const auto = e.automation ? ` ${e.automation}` : '';
          const trigger = e.trigger ? ` trigger="${e.trigger}"` : '';
          const exec = e.execution ?? e.state;
          const err = e.error ? ` ERROR: ${e.error}` : '';
          return `${e.start}:${auto} ${exec}${trigger}${err}`;
        }).join('\n');
        if (total > limit) {
          return `${header}:\n${lines}\n... (${total - limit} more hidden)`;
        }
        return `${header}:\n${lines}`;
      }
      case 'echarts':
        return `📊 Chart${spec.title ? `: ${spec.title}` : ''} (rendered as interactive ECharts)`;
      case 'calendar_events': {
        const limit = AnalystSession.MAX_TEXT_ROWS;
        const total = spec.entries.length;
        const shown = spec.entries.slice(0, limit);
        const lines = shown.map((e) => {
          const time = e.all_day ? 'all-day' : (e.start ?? '');
          const loc = e.location ? ` 📍${e.location}` : '';
          return `${time}: ${e.summary}${loc}`;
        }).join('\n');
        if (total > limit) {
          return `📅 ${total} events for ${spec.entity_id}:\n${lines}\n... (${total - limit} more hidden)`;
        }
        return `📅 ${total} events for ${spec.entity_id}:\n${lines}`;
      }
      default:
        return JSON.stringify(spec);
    }
  }

  /** Find the best HA conversation agent. Uses forced agentId if configured. */
  private _findConversationAgent(): string | null {
    if (this._forcedAgentId) return this._forcedAgentId;

    const entities = Object.keys(this.hass.states).filter((id) =>
      id.startsWith('conversation.'),
    );

    const claude = entities.find(
      (id) => id.includes('claude') || id.includes('anthropic'),
    );
    if (claude) return claude;

    const nonDefault = entities.find(
      (id) => id !== 'conversation.home_assistant',
    );
    if (nonDefault) return nonDefault;

    return entities.length > 0 ? entities[0] : null;
  }
}
