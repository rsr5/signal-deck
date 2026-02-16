/**
 * AnalystPanel — the Signal Analyst chat UI.
 *
 * A Lit component that lives in the right-hand pane of Signal Deck.
 * It provides a chat interface to the AI assistant and shows tool
 * call progress, code execution, and results.
 */

import { LitElement, html, css, type TemplateResult, unsafeCSS } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { Marked } from 'marked';
import { AnalystSession, type AnalystEvent } from './analyst-session.js';
import type { ShellEngine } from '../engine/wasm-bridge.js';
import type { HomeAssistant, RenderSpec } from '../types/index.js';
import { highlightPython, highlightStyles } from '../utils/highlight.js';

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/** Languages whose fenced blocks are executed in the shell. */
const SHELL_LANGUAGES = new Set(['signal-deck', 'signal_deck']);

/**
 * Convert ```signal-deck blocks to syntax-highlighted <pre> and strip
 * ```result blocks (results are shown inline via the shell pane).
 */
function renderShellBlocks(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*```(\w[\w-]*)\s*$/.exec(lines[i]);
    if (m && SHELL_LANGUAGES.has(m[1])) {
      // Collect the code inside the fence.
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const highlighted = highlightPython(codeLines.join('\n'));
      out.push(`<pre class="sd-code-block"><code class="hljs">${highlighted}</code></pre>`);
      continue;
    }
    // Strip ```result blocks entirely.
    if (m && m[1] === 'result') {
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i++;
      i++;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n').trim();
}

/** Shared Marked instance — synchronous, no async needed. */
const marked = new Marked({ async: false, breaks: true, gfm: true });

// ---------------------------------------------------------------------------
// Message model
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'status';
  content: string;
  /** For status messages — the event that produced them. */
  event?: AnalystEvent;
  /** Timestamp. */
  ts: number;
  /** True if this is an intermediate LLM response (not the final answer). */
  intermediate?: boolean;
  /** Whether the message is currently collapsed (for intermediate messages). */
  collapsed?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement('analyst-panel')
export class AnalystPanel extends LitElement {
  @property({ attribute: false })
  hass!: HomeAssistant;

  @property({ attribute: false })
  engine!: ShellEngine;

  /**
   * Callback invoked when the analyst wants to show code in the user's shell.
   * The parent (SignalDeck) connects this to its own output list.
   */
  @property({ attribute: false })
  shellCallback?: (input: string, spec: RenderSpec) => void;

  /** Force a specific conversation agent ID (for debug/testing). */
  @property({ attribute: false })
  agentId?: string;

  /** Callback to request user confirmation for service calls. */
  @property({ attribute: false })
  confirmServiceCall?: (params: Record<string, unknown>) => Promise<boolean>;

  @state()
  private _messages: ChatMessage[] = [];

  @state()
  private _inputValue = '';

  @state()
  private _running = false;

  @state()
  private _awaitingContinue = false;

  @query('#analyst-messages')
  private _messagesEl!: HTMLElement;

  private _session: AnalystSession | null = null;
  private _inputHistory: string[] = [];
  private _historyIndex = -1;
  private _savedInput = '';

  /** Resolved conversation agent entity ID. */
  private get _resolvedAgentId(): string | null {
    return this._getSession().resolvedAgentId;
  }

  /** Friendly model label for the header badge. */
  private get _modelLabel(): string {
    const agentId = this._resolvedAgentId;
    if (!agentId) return '—';

    // Try friendly_name from HA state first.
    const entity = this.hass?.states?.[agentId];
    if (entity?.attributes?.friendly_name) {
      return entity.attributes.friendly_name as string;
    }

    // Fall back to a cleaned-up entity ID:
    // "conversation.google_generative_ai_conversation" → "google generative ai"
    return agentId
      .replace('conversation.', '')
      .replace(/_conversation$/, '')
      .replace(/_/g, ' ');
  }

  /** Get or create the persistent analyst session. */
  private _getSession(): AnalystSession {
    if (!this._session) {
      this._session = new AnalystSession(this.hass, this.engine, {
        agentId: this.agentId,
        confirmServiceCall: this.confirmServiceCall,
      });
    }
    // Keep hass reference up-to-date (it changes on reconnect).
    this._session.hassRef = this.hass;
    // Keep confirmation callback up-to-date.
    this._session.confirmCallback = this.confirmServiceCall;
    return this._session;
  }

  // -----------------------------------------------------------------------
  // Input handling
  // -----------------------------------------------------------------------

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateHistory(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._navigateHistory(1);
    }
  }

  /** Navigate through input history. direction: -1 = older, 1 = newer. */
  private _navigateHistory(direction: number): void {
    if (this._inputHistory.length === 0) return;

    if (this._historyIndex === -1 && direction === -1) {
      // Save current input before navigating.
      this._savedInput = this._inputValue;
      this._historyIndex = this._inputHistory.length - 1;
    } else {
      const next = this._historyIndex + direction;
      if (next < 0) return;
      if (next >= this._inputHistory.length) {
        // Back to current input.
        this._historyIndex = -1;
        this._inputValue = this._savedInput;
        return;
      }
      this._historyIndex = next;
    }

    this._inputValue = this._inputHistory[this._historyIndex];
  }

  private _handleInput(e: Event): void {
    this._inputValue = (e.target as HTMLInputElement).value;
  }

  private async _submit(): Promise<void> {
    const input = this._inputValue.trim();
    if (!input || this._running || !this.engine) return;

    // Push to command history (avoid consecutive duplicates).
    if (this._inputHistory.length === 0 || this._inputHistory[this._inputHistory.length - 1] !== input) {
      this._inputHistory.push(input);
    }
    this._historyIndex = -1;
    this._savedInput = '';

    this._inputValue = '';
    this._running = true;
    this._awaitingContinue = false;

    // Add user message.
    this._addMessage({ role: 'user', content: input, ts: Date.now() });

    // Use the persistent session (keeps conversation history).
    const session = this._getSession();

    try {
      for await (const event of session.run(input, this.shellCallback)) {
        this._handleEvent(event);
      }
    } catch (e) {
      this._addMessage({
        role: 'status',
        content: `Error: ${e}`,
        ts: Date.now(),
      });
    }

    this._running = false;
  }

  private _cancel(): void {
    this._session?.cancel();
  }

  /** Resume the agent loop after hitting max iterations. */
  private async _continue(): Promise<void> {
    if (this._running || !this._session) return;
    this._awaitingContinue = false;
    this._running = true;

    try {
      for await (const event of this._session.run(
        'Continue investigating. If you have enough data, give your final answer with NO code block.',
        this.shellCallback,
      )) {
        this._handleEvent(event);
      }
    } catch (e) {
      this._addMessage({
        role: 'status',
        content: `Error: ${e}`,
        ts: Date.now(),
      });
    }

    this._running = false;
  }

  // -----------------------------------------------------------------------
  // Event handling
  // -----------------------------------------------------------------------

  private _handleEvent(event: AnalystEvent): void {
    switch (event.type) {
      case 'thinking':
        this._addMessage({
          role: 'status',
          content: '⟳ Thinking…',
          event,
          ts: Date.now(),
        });
        break;

      case 'message':
        // Replace the "thinking" status with the actual message.
        // Intermediate messages are auto-collapsed.
        this._replaceLastStatus({
          role: 'assistant',
          content: event.text ?? '',
          ts: Date.now(),
          intermediate: event.intermediate ?? false,
          collapsed: event.intermediate ?? false,
        });
        break;

      case 'code_running': {
        const highlighted = highlightPython(event.code ?? '');
        this._addMessage({
          role: 'status',
          content: `▶ Running:\n<pre class="sd-code-block"><code class="hljs">${highlighted}</code></pre>`,
          event,
          ts: Date.now(),
        });
        break;
      }

      case 'code_result':
        // Replace "running" status with result.
        this._replaceLastStatus({
          role: 'status',
          content: `✓ ${this._truncate(event.result ?? '(ok)', 80)}`,
          event,
          ts: Date.now(),
        });
        break;

      case 'error':
        this._addMessage({
          role: 'status',
          content: `✗ ${event.text}`,
          event,
          ts: Date.now(),
        });
        break;

      case 'done':
        if (event.text) {
          this._addMessage({
            role: 'status',
            content: `✓ ${event.text}`,
            event,
            ts: Date.now(),
          });
        }
        break;

      case 'max_iterations':
        this._awaitingContinue = true;
        this._addMessage({
          role: 'status',
          content: `⚠ ${event.text}`,
          event,
          ts: Date.now(),
        });
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Message helpers
  // -----------------------------------------------------------------------

  private _addMessage(msg: ChatMessage): void {
    this._messages = [...this._messages, msg];
    this._scrollToBottom();
  }

  /** Replace the last status message with a new message. */
  private _replaceLastStatus(msg: ChatMessage): void {
    const msgs = [...this._messages];
    // Find last status message.
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'status') {
        msgs[i] = msg;
        this._messages = msgs;
        this._scrollToBottom();
        return;
      }
    }
    // No status found — just append.
    this._addMessage(msg);
  }

  private _scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this._messagesEl) {
        this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
      }
    });
  }

  private _truncate(s: string, max: number): string {
    const oneLine = s.replace(/\n/g, ' ');
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
  }

  clearHistory(): void {
    this._messages = [];
  }

  /** Copy the full conversation as plain text to clipboard. */
  private async _copyConversation(): Promise<void> {
    const text = this._messages
      .map((msg) => {
        const prefix = msg.role === 'user' ? '> ' : msg.role === 'assistant' ? '' : '  ';
        return `${prefix}${msg.content}`;
      })
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  /** Toggle collapsed state of a message by index. */
  private _toggleCollapse(idx: number): void {
    const msgs = [...this._messages];
    msgs[idx] = { ...msgs[idx], collapsed: !msgs[idx].collapsed };
    this._messages = msgs;
  }

  /** Render markdown content as HTML, with signal-deck code blocks syntax-highlighted. */
  private _renderMarkdown(content: string): TemplateResult {
    const cleaned = renderShellBlocks(content);
    if (!cleaned) return html``;
    const htmlStr = marked.parse(cleaned) as string;
    return html`<div class="md">${unsafeHTML(htmlStr)}</div>`;
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      font-family: 'Iosevka Nerd Font', 'Iosevka', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 13px;
      line-height: 1.5;
      color: var(--sd-fg, #a9b1d6);
      background: var(--sd-bg, #1a1b26);
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--sd-border, #3b4261);
      color: var(--sd-accent, #7aa2f7);
      font-weight: 600;
      font-size: 12px;
      flex-shrink: 0;
    }

    .panel-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .model-badge {
      font-size: 10px;
      font-weight: 400;
      color: var(--sd-dim, #565f89);
      background: var(--sd-surface, #111820);
      border: 1px solid var(--sd-border, #1e2a3a);
      border-radius: 3px;
      padding: 1px 6px;
      margin-left: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      cursor: default;
    }

    .panel-actions {
      display: flex;
      gap: 4px;
    }

    .panel-btn {
      background: transparent;
      color: var(--sd-dim, #565f89);
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      padding: 2px 4px;
      border-radius: 3px;
      transition: color 0.15s;
    }

    .panel-btn:hover {
      color: var(--sd-fg, #a9b1d6);
    }

    #analyst-messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
      user-select: text;
      -webkit-user-select: text;
    }

    .msg {
      margin-bottom: 8px;
      max-width: 100%;
    }

    .msg-user {
      text-align: right;
    }

    .msg-user .msg-bubble {
      background: rgba(122, 162, 247, 0.15);
      border: 1px solid rgba(122, 162, 247, 0.25);
      color: var(--sd-fg, #a9b1d6);
      display: inline-block;
      text-align: left;
      padding: 6px 10px;
      border-radius: 8px 8px 2px 8px;
      max-width: 90%;
      word-break: break-word;
    }

    .msg-assistant .msg-bubble {
      background: var(--sd-surface, #24283b);
      border: 1px solid var(--sd-border, #3b4261);
      padding: 6px 10px;
      border-radius: 8px 8px 8px 2px;
      max-width: 100%;
      word-break: break-word;
    }

    /* Markdown rendered content */
    .msg-bubble .md {
      line-height: 1.55;
    }

    .msg-bubble .md > :first-child {
      margin-top: 0;
    }

    .msg-bubble .md > :last-child {
      margin-bottom: 0;
    }

    .msg-bubble .md p {
      margin: 0.4em 0;
    }

    .msg-bubble .md h1,
    .msg-bubble .md h2,
    .msg-bubble .md h3,
    .msg-bubble .md h4 {
      margin: 0.6em 0 0.3em;
      color: var(--sd-accent, #7aa2f7);
      font-size: 1em;
      font-weight: 600;
    }

    .msg-bubble .md h1 {
      font-size: 1.15em;
    }

    .msg-bubble .md h2 {
      font-size: 1.08em;
    }

    .msg-bubble .md strong {
      color: var(--sd-fg, #a9b1d6);
      font-weight: 700;
    }

    .msg-bubble .md em {
      color: var(--sd-dim, #565f89);
    }

    .msg-bubble .md code {
      background: rgba(122, 162, 247, 0.1);
      border: 1px solid rgba(122, 162, 247, 0.15);
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 0.92em;
      font-family: inherit;
    }

    .msg-bubble .md pre {
      background: var(--sd-bg, #1a1b26);
      border: 1px solid var(--sd-border, #3b4261);
      border-radius: 4px;
      padding: 6px 8px;
      overflow-x: auto;
      margin: 0.4em 0;
    }

    .msg-bubble .md pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.9em;
    }

    .msg-bubble .md ul,
    .msg-bubble .md ol {
      margin: 0.4em 0;
      padding-left: 1.4em;
    }

    .msg-bubble .md li {
      margin: 0.15em 0;
    }

    .msg-bubble .md blockquote {
      border-left: 3px solid var(--sd-accent, #7aa2f7);
      margin: 0.4em 0;
      padding: 2px 8px;
      color: var(--sd-dim, #565f89);
    }

    .msg-bubble .md table {
      border-collapse: collapse;
      margin: 0.4em 0;
      width: 100%;
      font-size: 0.92em;
    }

    .msg-bubble .md th,
    .msg-bubble .md td {
      border: 1px solid var(--sd-border, #3b4261);
      padding: 3px 6px;
      text-align: left;
    }

    .msg-bubble .md th {
      background: rgba(122, 162, 247, 0.08);
      color: var(--sd-accent, #7aa2f7);
      font-weight: 600;
    }

    .msg-bubble .md a {
      color: var(--sd-accent, #7aa2f7);
      text-decoration: none;
    }

    .msg-bubble .md a:hover {
      text-decoration: underline;
    }

    .msg-bubble .md hr {
      border: none;
      border-top: 1px solid var(--sd-border, #3b4261);
      margin: 0.6em 0;
    }

    /* Collapsed intermediate message */
    .msg-collapsed {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-size: 11px;
      color: var(--sd-dim, #565f89);
      padding: 2px 0;
      border-radius: 4px;
      transition: color 0.15s;
    }

    .msg-collapsed:hover {
      color: var(--sd-fg, #a9b1d6);
    }

    .collapse-toggle {
      font-size: 10px;
      flex-shrink: 0;
      width: 12px;
    }

    .collapse-preview {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .collapse-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-size: 10px;
      color: var(--sd-dim, #565f89);
      margin-bottom: 4px;
      transition: color 0.15s;
    }

    .collapse-bar:hover {
      color: var(--sd-fg, #a9b1d6);
    }

    .collapse-label {
      opacity: 0.6;
    }

    .msg-status {
      font-size: 11px;
      color: var(--sd-dim, #565f89);
      padding: 2px 0;
    }

    .msg-status.running {
      color: var(--sd-warning, #e0af68);
    }

    .msg-status.success {
      color: var(--sd-success, #9ece6a);
    }

    .msg-status.error {
      color: var(--sd-error, #f7768e);
    }

    .input-row {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      border-top: 1px solid var(--sd-border, #3b4261);
      gap: 6px;
      flex-shrink: 0;
    }

    #analyst-input {
      flex: 1;
      background: var(--sd-surface, #24283b);
      border: 1px solid var(--sd-border, #3b4261);
      border-radius: 6px;
      color: var(--sd-fg, #a9b1d6);
      font-family: inherit;
      font-size: 12px;
      padding: 6px 10px;
      outline: none;
      caret-color: var(--sd-accent, #7aa2f7);
    }

    #analyst-input:focus {
      border-color: var(--sd-accent, #7aa2f7);
    }

    #analyst-input::placeholder {
      color: var(--sd-dim, #565f89);
      opacity: 0.6;
    }

    .send-btn {
      background: var(--sd-accent, #7aa2f7);
      color: var(--sd-bg, #1a1b26);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      flex-shrink: 0;
    }

    .send-btn:hover {
      opacity: 0.85;
    }

    .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .cancel-btn {
      background: var(--sd-error, #f7768e);
      color: var(--sd-bg, #1a1b26);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }

    .continue-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 8px 12px;
      border-top: 1px solid var(--sd-border, #1e2a3a);
      flex-shrink: 0;
    }

    .continue-label {
      font-size: 11px;
      color: var(--sd-warning, #ffd866);
    }

    .continue-btn {
      background: transparent;
      color: var(--sd-accent, #00e5ff);
      border: 1px solid var(--sd-accent, #00e5ff);
      border-radius: 4px;
      padding: 4px 12px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }

    .continue-btn:hover {
      background: var(--sd-accent, #00e5ff);
      color: var(--sd-bg, #0a0e14);
    }

    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--sd-dim, #565f89);
      font-size: 12px;
      padding: 24px;
      text-align: center;
      line-height: 1.6;
    }

    /* ── Signal Deck code blocks (syntax highlighted) ── */
    .sd-code-block {
      background: rgba(26, 27, 38, 0.8);
      border: 1px solid var(--sd-border, #3b4261);
      border-left: 3px solid var(--sd-accent, #7aa2f7);
      border-radius: 4px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 0.5em 0;
      font-size: 0.9em;
      line-height: 1.55;
    }

    .sd-code-block code {
      background: none;
      border: none;
      padding: 0;
      font-family: inherit;
    }

    .msg-status .sd-code-block {
      margin: 4px 0 0 0;
    }

    /* ── highlight.js — Tokyo Night ── */
    ${unsafeCSS(highlightStyles)}

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .spinning {
      display: inline-block;
      animation: spin 1s linear infinite;
    }
  `;

  protected render(): TemplateResult {
    return html`
      <div class="panel-header">
        <div class="panel-header-left">
          <span>󰚩</span>
          <span>Signal Analyst</span>
          <span class="model-badge" title=${this._resolvedAgentId ?? 'No agent'}>${this._modelLabel}</span>
        </div>
        <div class="panel-actions">
          <button class="panel-btn" @click=${this._copyConversation} title="Copy conversation">⧉</button>
          <button class="panel-btn" @click=${() => this.clearHistory()} title="Clear history">✕</button>
        </div>
      </div>

      ${this._messages.length === 0
        ? html`
            <div class="empty-state">
              Ask the analyst anything about<br />your Home Assistant setup.
            </div>
          `
        : html`
            <div id="analyst-messages">
              ${this._messages.map((msg, idx) => this._renderMessage(msg, idx))}
            </div>
          `}

      ${this._awaitingContinue
        ? html`
            <div class="continue-bar">
              <span class="continue-label">⚠ Iteration limit reached</span>
              <button class="continue-btn" @click=${this._continue}>▶ Continue</button>
            </div>
          `
        : html``}

      <div class="input-row">
        <input
          id="analyst-input"
          type="text"
          .value=${this._inputValue}
          @input=${this._handleInput}
          @keydown=${this._handleKeyDown}
          placeholder=${this._running ? 'Running…' : 'Ask Signal Analyst…'}
          ?disabled=${this._running}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
        />
        ${this._running
          ? html`<button class="cancel-btn" @click=${this._cancel}>✕ Stop</button>`
          : html`<button class="send-btn" @click=${this._submit} ?disabled=${!this._inputValue.trim()}>Ask</button>`}
      </div>
    `;
  }

  private _renderMessage(msg: ChatMessage, idx: number): TemplateResult {
    switch (msg.role) {
      case 'user':
        return html`
          <div class="msg msg-user">
            <div class="msg-bubble">${msg.content}</div>
          </div>
        `;

      case 'assistant': {
        if (msg.intermediate && msg.collapsed) {
          // Collapsed intermediate — show a one-line summary with toggle.
          const preview = this._truncate(msg.content, 50);
          return html`
            <div class="msg msg-collapsed" @click=${() => this._toggleCollapse(idx)}>
              <span class="collapse-toggle">▸</span>
              <span class="collapse-preview">${preview}</span>
            </div>
          `;
        }
        // Expanded message (final or toggled open).
        return html`
          <div class="msg msg-assistant">
            ${msg.intermediate
              ? html`<div class="collapse-bar" @click=${() => this._toggleCollapse(idx)}>
                  <span class="collapse-toggle">▾</span>
                  <span class="collapse-label">intermediate</span>
                </div>`
              : ''}
            <div class="msg-bubble">${this._renderMarkdown(msg.content)}</div>
          </div>
        `;
      }

      case 'status': {
        let statusClass = '';
        if (msg.content.startsWith('⟳') || msg.content.startsWith('▶')) {
          statusClass = 'running';
        } else if (msg.content.startsWith('✓')) {
          statusClass = 'success';
        } else if (msg.content.startsWith('✗') || msg.content.startsWith('⚠')) {
          statusClass = 'error';
        }
        // Status messages may contain highlighted code blocks (HTML).
        const hasHtml = msg.content.includes('<pre');
        return html`
          <div class="msg msg-status ${statusClass}">
            ${msg.content.startsWith('⟳')
              ? html`<span class="spinning">⟳</span>${msg.content.slice(1)}`
              : hasHtml
                ? unsafeHTML(msg.content)
                : msg.content}
          </div>
        `;
      }

      default:
        return html`<div class="msg">${msg.content}</div>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'analyst-panel': AnalystPanel;
  }
}
