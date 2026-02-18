/**
 * Signal Deck — The oscilloscope for Home Assistant.
 *
 * Main Lovelace card component.
 */

import { LitElement, html, css, nothing, svg, unsafeCSS, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { initEngine, ShellEngine } from './engine/wasm-bridge.js';
import { fulfillHostCall, isHostCall } from './host/host-functions.js';
import type { HomeAssistant, SignalDeckConfig, RenderSpec } from './types/index.js';
import { highlightPython, highlightStyles } from './utils/highlight.js';
import { renderEntityCard } from './components/entity-renderers.js';
// ECharts — minimal bundle with only the chart types we need.
import * as echarts from 'echarts/core';
import { LineChart, BarChart, PieChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  CanvasRenderer,
]);

import './assistant/analyst-panel.js';

/** A single output entry in the REPL history. */
interface OutputEntry {
  input?: string;
  spec: RenderSpec;
}

@customElement('signal-deck')
export class SignalDeck extends LitElement {
  // --- HA Lovelace card interface ---

  @property({ attribute: false })
  hass!: HomeAssistant;

  @state()
  private _config: SignalDeckConfig = { type: 'custom:signal-deck' };

  @state()
  private _engine: ShellEngine | null = null;

  @state()
  private _outputs: OutputEntry[] = [];

  @state()
  private _loading = true;

  @state()
  private _inputValue = '';

  @state()
  private _historyIndex = -1;

  @state()
  private _showAnalyst = false;

  /** Whether the overlay console is open (only used in overlay mode). */
  @state()
  private _overlayOpen = false;

  /** Current analyst pane width in pixels (user-resizable). */
  @state()
  private _analystWidth = 340;

  /** Pending service call awaiting user confirmation. */
  @state()
  private _pendingServiceCall: {
    callId: string;
    domain: string;
    service: string;
    serviceData: Record<string, unknown>;
    resolve: (confirmed: boolean) => void;
  } | null = null;

  /** Table pagination: keyed by a unique table id, value is current page (0-based). */
  @state()
  private _tablePages: Map<string, number> = new Map();

  /** Counter for assigning unique IDs to table specs. */
  private _tableIdCounter = 0;

  /** Map from TableSpec object identity to a stable ID for pagination. */
  private _tableIdMap: WeakMap<object, string> = new WeakMap();

  @query('#output-container')
  private _outputContainer!: HTMLElement;

  // --- Lovelace lifecycle ---

  setConfig(config: SignalDeckConfig): void {
    this._config = { ...config };
    if (config.show_analyst !== undefined) {
      this._showAnalyst = config.show_analyst;
    }
  }

  static getStubConfig() {
    return { type: 'custom:signal-deck', title: 'Signal Deck' };
  }

  getCardSize(): number {
    return this._config.mode === 'overlay' ? 1 : 6;
  }

  // --- Lit lifecycle ---

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this._initWasm();
    window.addEventListener('keydown', this._onGlobalKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onGlobalKeyDown);
    this._engine?.dispose();
    this._engine = null;
  }

  private async _initWasm(): Promise<void> {
    try {
      await initEngine();
      this._engine = new ShellEngine();
      this._loading = false;

      // Show welcome message.
      this._outputs = [
        {
          spec: {
            type: 'text',
            content: '⚡ Signal Deck v0.1.0 — The oscilloscope for Home Assistant\n   Type :help for commands',
          },
        },
      ];
    } catch (e) {
      this._loading = false;
      this._outputs = [
        {
          spec: {
            type: 'error',
            message: `Failed to initialize WASM engine: ${e}`,
          },
        },
      ];
    }
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('_outputs')) {
      this._scrollToBottom();
    }
  }

  // --- Input handling ---

  private async _handleKeyDown(e: KeyboardEvent): Promise<void> {
    if (e.key === 'Enter') {
      e.preventDefault();
      await this._submitInput();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._navigateHistory(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._navigateHistory(1);
    }
  }

  private async _submitInput(): Promise<void> {
    const input = this._inputValue.trim();
    if (!input || !this._engine) return;

    this._inputValue = '';
    this._historyIndex = -1;

    // Eval the input through the Rust engine.
    let spec = this._engine.eval(input);

    // Handle :clear — wipe output history.
    if (spec.type === 'text' && (spec as { content: string }).content === '\x1b[clear]') {
      this._outputs = [];
      return;
    }

    // If the engine requests a host call, fulfill it.
    // Loop because chained calls (e.g. context replay + new code) may
    // produce multiple sequential host_call specs.
    while (isHostCall(spec) && this.hass) {
      // Gate service calls behind user confirmation.
      if (spec.method === 'call_service') {
        const confirmed = await this._requestServiceConfirmation(spec.call_id, spec.params);
        if (!confirmed) {
          spec = this._engine.fulfillHostCall(
            spec.call_id,
            JSON.stringify({ error: 'Service call cancelled by user' }),
          );
          continue;
        }
      }
      const result = await fulfillHostCall(this.hass, spec.method, spec.params);
      spec = this._engine.fulfillHostCall(spec.call_id, result.data);
    }

    // Add to output.
    this._outputs = [...this._outputs, { input, spec }];
  }

  // -----------------------------------------------------------------------
  // Service call confirmation gate
  // -----------------------------------------------------------------------

  /** Show confirmation UI and return a Promise that resolves when the user decides. */
  private _requestServiceConfirmation(
    callId: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this._pendingServiceCall = {
        callId,
        domain: (params.domain as string) ?? '',
        service: (params.service as string) ?? '',
        serviceData: ((params.service_data ?? params.data ?? {}) as Record<string, unknown>),
        resolve,
      };
    });
  }

  /** User confirmed the pending service call. */
  private _confirmServiceCall(): void {
    if (this._pendingServiceCall) {
      this._pendingServiceCall.resolve(true);
      this._pendingServiceCall = null;
    }
  }

  /** User denied the pending service call. */
  private _denyServiceCall(): void {
    if (this._pendingServiceCall) {
      this._pendingServiceCall.resolve(false);
      this._pendingServiceCall = null;
    }
  }

  /**
   * Confirmation callback exposed for AnalystSession.
   * Returns a promise that resolves to true (confirmed) or false (denied).
   */
  public requestServiceConfirmation(
    params: Record<string, unknown>,
  ): Promise<boolean> {
    return this._requestServiceConfirmation('analyst', params);
  }

  private _navigateHistory(direction: number): void {
    if (!this._engine) return;
    const hist = this._engine.history();
    if (hist.length === 0) return;

    let newIndex = this._historyIndex + direction;
    if (newIndex < -1) newIndex = -1;
    if (newIndex >= hist.length) newIndex = hist.length - 1;

    this._historyIndex = newIndex;

    if (newIndex === -1) {
      this._inputValue = '';
    } else {
      this._inputValue = hist[hist.length - 1 - newIndex];
    }
  }

  private _scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (this._outputContainer) {
        this._outputContainer.scrollTop = this._outputContainer.scrollHeight;
      }
    });
  }

  private _handleInput(e: Event): void {
    this._inputValue = (e.target as HTMLInputElement).value;
  }

  private _toggleAnalyst(): void {
    this._showAnalyst = !this._showAnalyst;
  }

  // -----------------------------------------------------------------------
  // Overlay console mode
  // -----------------------------------------------------------------------

  private _toggleOverlay(): void {
    this._overlayOpen = !this._overlayOpen;
    if (this._overlayOpen) {
      // Focus the input after the overlay opens.
      this.updateComplete.then(() => {
        const input = this.shadowRoot?.querySelector('#repl-input') as HTMLInputElement | null;
        input?.focus();
      });
    }
  }

  private _closeOverlay(): void {
    this._overlayOpen = false;
  }

  /** Global keyboard handler — Escape closes overlay, backtick toggles it. */
  private _onGlobalKeyDown = (e: KeyboardEvent): void => {
    if (this._config.mode !== 'overlay') return;

    if (e.key === 'Escape' && this._overlayOpen) {
      e.preventDefault();
      this._closeOverlay();
      return;
    }

    // Backtick (`) toggles overlay — but only if no input/textarea is focused.
    if (e.key === '`' && !this._isInputFocused()) {
      e.preventDefault();
      this._toggleOverlay();
    }
  };

  /** Check if a text input or textarea currently has focus (avoid stealing backtick). */
  private _isInputFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    // Also check shadow roots.
    if (active.shadowRoot?.activeElement) {
      const innerTag = active.shadowRoot.activeElement.tagName.toLowerCase();
      return innerTag === 'input' || innerTag === 'textarea';
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Analyst pane resize
  // -----------------------------------------------------------------------

  private _onResizeStart = (e: PointerEvent): void => {
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = this._analystWidth;

    const onMove = (ev: PointerEvent) => {
      // Dragging left → increase analyst width.
      const delta = startX - ev.clientX;
      const newWidth = Math.max(200, Math.min(800, startWidth + delta));
      this._analystWidth = newWidth;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * Called by the analyst panel when it runs code "in the shell" —
   * the output appears in the user's REPL pane.
   */
  private _shellCallback = (input: string, spec: RenderSpec): void => {
    this._outputs = [...this._outputs, { input: `[analyst] ${input}`, spec }];
  };

  // --- Rendering ---

  static styles = css`
    :host {
      display: block;
      height: 100%;
      font-family: 'Iosevka Nerd Font', 'Iosevka', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 13px;
      line-height: 1.5;
      --sd-bg: #0a0e14;
      --sd-fg: #c5cdd9;
      --sd-accent: #00e5ff;
      --sd-error: #ff3d71;
      --sd-success: #00ff9f;
      --sd-warning: #ffd866;
      --sd-dim: #4a5568;
      --sd-surface: #111820;
      --sd-border: #1e2a3a;
      --sd-prompt: #bf95f9;
      --sd-cyan: #00e5ff;
      --sd-magenta: #ff2cf1;
      --sd-orange: #ff9e64;
      --sd-glow: rgba(0, 229, 255, 0.15);
    }

    ha-card {
      background: var(--sd-bg);
      color: var(--sd-fg);
      overflow: hidden;
      height: var(--sd-card-height, 500px);
      display: flex;
      flex-direction: column;
      position: relative;
    }

    ha-card::after {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.03) 2px,
        rgba(0, 0, 0, 0.03) 4px
      );
      pointer-events: none;
      z-index: 1;
    }

    /* ── Overlay mode — launcher button ─────────────────────────── */

    .launcher-card {
      background: var(--sd-bg) !important;
      height: auto !important;
      display: inline-flex !important;
      border-radius: 12px !important;
      overflow: visible !important;
    }

    .launcher-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 42px;
      height: 42px;
      border: none;
      border-radius: 12px;
      background: var(--sd-bg);
      color: var(--sd-accent);
      cursor: pointer;
      font-size: 20px;
      transition: all 0.2s;
    }

    .launcher-btn:hover {
      background: var(--sd-surface);
      transform: scale(1.1);
      box-shadow: 0 0 16px var(--sd-glow);
    }

    .launcher-btn:active {
      transform: scale(0.95);
    }

    .launcher-icon {
      pointer-events: none;
    }

    /* ── Overlay panel (fixed over HA) ──────────────────────────── */

    .overlay-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 99998;
      animation: sd-fade-in 0.2s ease-out;
    }

    .overlay-panel {
      position: fixed;
      left: 0;
      right: 0;
      z-index: 99999;
      background: var(--sd-bg);
      color: var(--sd-fg);
      font-family: 'Iosevka Nerd Font', 'Iosevka', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      flex-direction: column;
      box-shadow: 0 0 40px rgba(0, 229, 255, 0.08), 0 8px 32px rgba(0, 0, 0, 0.6);
    }

    .overlay-top {
      top: 0;
      border-bottom: 2px solid var(--sd-accent);
      border-radius: 0 0 8px 8px;
      animation: sd-slide-down 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 4px 24px rgba(0, 229, 255, 0.1), 0 8px 32px rgba(0, 0, 0, 0.6);
    }

    .overlay-bottom {
      bottom: 0;
      border-top: 2px solid var(--sd-accent);
      border-radius: 8px 8px 0 0;
      animation: sd-slide-up 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 -4px 24px rgba(0, 229, 255, 0.1), 0 -8px 32px rgba(0, 0, 0, 0.6);
    }

    .overlay-full {
      top: 0;
      bottom: 0;
      animation: sd-fade-in 0.2s ease-out;
    }

    @keyframes sd-slide-down {
      from { transform: translateY(-100%); }
      to   { transform: translateY(0); }
    }

    @keyframes sd-slide-up {
      from { transform: translateY(100%); }
      to   { transform: translateY(0); }
    }

    @keyframes sd-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px 8px;
      border-bottom: 1px solid var(--sd-border);
      color: var(--sd-accent);
      font-weight: 600;
      font-size: 14px;
      flex-shrink: 0;
      text-shadow: 0 0 8px var(--sd-glow);
    }

    .header-icon {
      font-size: 16px;
      filter: drop-shadow(0 0 4px var(--sd-glow));
    }

    .header-by {
      font-weight: 400;
      font-size: 12px;
      color: var(--sd-dim);
    }

    .header-author {
      color: var(--sd-accent);
      font-weight: 600;
      text-decoration: none;
      transition: color 0.15s;
    }

    .header-author:hover {
      color: var(--sd-success);
      text-decoration: underline;
      text-shadow: 0 0 8px rgba(0, 255, 159, 0.4);
    }

    .header-spacer {
      flex: 1;
    }

    .header-btn {
      background: transparent;
      color: var(--sd-dim);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 2px 8px;
      font-family: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .header-btn:hover {
      color: var(--sd-accent);
      border-color: var(--sd-border);
    }

    .header-btn.active {
      color: var(--sd-accent);
      background: rgba(0, 229, 255, 0.1);
      border-color: rgba(0, 229, 255, 0.3);
    }

    /* Two-pane layout */
    .deck-layout {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .shell-pane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .analyst-pane {
      flex-shrink: 0;
      border-left: none;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }

    .resize-handle {
      width: 5px;
      cursor: col-resize;
      background: var(--sd-border);
      flex-shrink: 0;
      transition: background 0.15s;
      position: relative;
    }

    .resize-handle:hover,
    .resize-handle:active {
      background: var(--sd-accent);
      box-shadow: 0 0 8px var(--sd-glow);
    }

    #output-container {
      padding: 8px 16px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
      user-select: text;
      -webkit-user-select: text;
    }

    .output-entry {
      margin-bottom: 8px;
      position: relative;
    }

    .input-line {
      color: var(--sd-dim);
      margin-bottom: 2px;
    }

    .input-line .prompt {
      color: var(--sd-prompt);
    }

    .input-line .user-input {
      color: var(--sd-fg);
    }

    .analyst-tag {
      color: var(--sd-accent);
      font-size: 0.9em;
      opacity: 0.7;
    }

    .analyst-code-block {
      background: rgba(10, 14, 20, 0.8);
      border: 1px solid var(--sd-border);
      border-left: 3px solid var(--sd-accent);
      border-radius: 4px;
      padding: 6px 10px;
      margin: 2px 0 4px 0;
      overflow-x: auto;
      font-size: 0.92em;
      line-height: 1.55;
    }

    .analyst-code-block code {
      background: none;
      border: none;
      padding: 0;
      font-family: inherit;
    }

    /* ── highlight.js — Tokyo Night ── */
    ${unsafeCSS(highlightStyles)}

    .text-output {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .error-output {
      color: var(--sd-error);
      white-space: pre-wrap;
    }

    .help-output {
      color: var(--sd-dim);
      white-space: pre-wrap;
    }

    .table-output {
      width: 100%;
      border-collapse: collapse;
      margin: 4px 0;
      font-size: 12px;
    }

    .table-output th {
      text-align: left;
      color: var(--sd-accent);
      border-bottom: 1px solid var(--sd-border);
      padding: 2px 8px 2px 0;
      font-weight: 600;
    }

    .table-output td {
      padding: 2px 8px 2px 0;
      color: var(--sd-fg);
      border-bottom: 1px solid var(--sd-surface);
    }

    .table-output tr:hover td {
      background: var(--sd-surface);
    }

    /* Table pagination */
    .table-pager {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      font-size: 11px;
    }

    .pager-btn {
      background: transparent;
      color: var(--sd-dim);
      border: 1px solid var(--sd-border);
      border-radius: 3px;
      padding: 1px 8px;
      font-family: inherit;
      font-size: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .pager-btn:hover:not(:disabled) {
      color: var(--sd-accent);
      border-color: var(--sd-accent);
    }

    .pager-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }

    .pager-info {
      color: var(--sd-dim);
      font-variant-numeric: tabular-nums;
    }

    /* State badges */
    .badge {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1.5;
      white-space: nowrap;
    }

    .badge-on {
      background: rgba(0, 255, 159, 0.12);
      color: var(--sd-success);
      border: 1px solid rgba(0, 255, 159, 0.3);
    }

    .badge-off {
      background: rgba(74, 85, 104, 0.2);
      color: var(--sd-dim);
      border: 1px solid rgba(74, 85, 104, 0.3);
    }

    .badge-open {
      background: rgba(255, 216, 102, 0.12);
      color: var(--sd-warning);
      border: 1px solid rgba(255, 216, 102, 0.3);
    }

    .badge-closed {
      background: rgba(74, 85, 104, 0.2);
      color: var(--sd-dim);
      border: 1px solid rgba(74, 85, 104, 0.3);
    }

    .badge-home {
      background: rgba(0, 255, 159, 0.12);
      color: var(--sd-success);
      border: 1px solid rgba(0, 255, 159, 0.3);
    }

    .badge-away {
      background: rgba(0, 229, 255, 0.12);
      color: var(--sd-accent);
      border: 1px solid rgba(0, 229, 255, 0.3);
    }

    .badge-active {
      background: rgba(0, 255, 159, 0.12);
      color: var(--sd-success);
      border: 1px solid rgba(0, 255, 159, 0.3);
    }

    .badge-idle,
    .badge-standby,
    .badge-paused {
      background: rgba(255, 216, 102, 0.12);
      color: var(--sd-warning);
      border: 1px solid rgba(255, 216, 102, 0.3);
    }

    .badge-playing {
      background: rgba(0, 229, 255, 0.12);
      color: var(--sd-accent);
      border: 1px solid rgba(0, 229, 255, 0.3);
    }

    .badge-locked {
      background: rgba(0, 255, 159, 0.12);
      color: var(--sd-success);
      border: 1px solid rgba(0, 255, 159, 0.3);
    }

    .badge-unlocked {
      background: rgba(255, 61, 113, 0.12);
      color: var(--sd-error);
      border: 1px solid rgba(255, 61, 113, 0.3);
    }

    .badge-unavailable,
    .badge-unknown {
      background: rgba(255, 61, 113, 0.08);
      color: var(--sd-error);
      border: 1px solid rgba(255, 61, 113, 0.2);
      opacity: 0.7;
    }

    .badge-numeric {
      background: rgba(191, 149, 249, 0.1);
      color: var(--sd-prompt);
      border: 1px solid rgba(191, 149, 249, 0.25);
      font-variant-numeric: tabular-nums;
    }

    .badge-jammed,
    .badge-problem,
    .badge-alarm {
      background: rgba(255, 61, 113, 0.12);
      color: var(--sd-error);
      border: 1px solid rgba(255, 61, 113, 0.3);
    }

    .badge-armed_home,
    .badge-armed_away,
    .badge-armed_night {
      background: rgba(255, 216, 102, 0.12);
      color: var(--sd-warning);
      border: 1px solid rgba(255, 216, 102, 0.3);
    }

    .badge-disarmed {
      background: rgba(0, 255, 159, 0.12);
      color: var(--sd-success);
      border: 1px solid rgba(0, 255, 159, 0.3);
    }

    .badge-triggered,
    .badge-pending {
      background: rgba(255, 61, 113, 0.15);
      color: var(--sd-error);
      border: 1px solid rgba(255, 61, 113, 0.4);
      animation: badge-pulse 1.5s ease-in-out infinite;
    }

    @keyframes badge-pulse {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }

    /* Entity card */
    .entity-card {
      background: var(--sd-surface);
      border: 1px solid var(--sd-border);
      border-radius: 8px;
      padding: 12px 16px;
      margin: 4px 0;
      transition: border-color 0.2s;
    }

    .entity-card:hover {
      border-color: rgba(0, 229, 255, 0.25);
    }

    .entity-card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .entity-card-icon {
      font-size: 24px;
      width: 32px;
      text-align: center;
      flex-shrink: 0;
    }

    .entity-card-name {
      font-weight: 600;
      color: var(--sd-fg);
      font-size: 14px;
    }

    .entity-card-id {
      color: var(--sd-dim);
      font-size: 11px;
    }

    .entity-card-state {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin: 8px 0;
    }

    .entity-card-state-value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    .entity-card-state-unit {
      font-size: 14px;
      color: var(--sd-dim);
    }

    .entity-card-meta {
      display: flex;
      gap: 12px;
      color: var(--sd-dim);
      font-size: 11px;
      margin-top: 4px;
      margin-bottom: 8px;
    }

    .entity-card-attrs {
      border-top: 1px solid var(--sd-border);
      padding-top: 8px;
      margin-top: 8px;
    }

    /* ── Shared entity sub-components ───────────────────────── */

    .entity-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0;
      font-size: 11px;
    }

    .entity-bar-label {
      color: var(--sd-dim);
      min-width: 90px;
      white-space: nowrap;
    }

    .entity-bar-track {
      flex: 1;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
    }

    .entity-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .entity-bar-value {
      color: var(--sd-fg);
      min-width: 32px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .entity-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: rgba(255, 255, 255, 0.06);
      color: var(--sd-dim);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    .entity-color-swatch {
      display: inline-block;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.15);
      vertical-align: middle;
      margin-left: 8px;
    }

    /* ── Light card ─────────────────────────────────────────── */

    .entity-light-details {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 6px 0;
      flex-wrap: wrap;
    }

    .entity-light-temp {
      font-size: 12px;
      color: var(--sd-warning);
    }

    .badge-light-mode {
      background: rgba(255, 216, 102, 0.1);
      color: var(--sd-warning);
      border-color: rgba(255, 216, 102, 0.25);
    }

    .badge-light-effect {
      background: rgba(191, 149, 249, 0.1);
      color: var(--sd-prompt);
      border-color: rgba(191, 149, 249, 0.25);
    }

    /* ── Binary sensor card ────────────────────────────────── */

    .entity-binary-state {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 8px 0;
    }

    .entity-binary-indicator {
      font-size: 28px;
      line-height: 1;
    }

    .entity-binary-label {
      font-size: 22px;
      font-weight: 700;
    }

    .badge-binary-dc {
      background: rgba(0, 229, 255, 0.1);
      color: var(--sd-accent);
      border-color: rgba(0, 229, 255, 0.2);
      margin-left: auto;
    }

    /* ── Climate card ──────────────────────────────────────── */

    .entity-climate-temps {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin: 8px 0;
    }

    .entity-climate-current-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--sd-fg);
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    .entity-climate-current-unit {
      font-size: 16px;
      color: var(--sd-dim);
    }

    .entity-climate-current-label {
      font-size: 10px;
      color: var(--sd-dim);
      margin-left: 4px;
    }

    .entity-climate-target {
      display: flex;
      align-items: baseline;
      gap: 4px;
    }

    .entity-climate-target-arrow {
      color: var(--sd-dim);
      font-size: 16px;
    }

    .entity-climate-target-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--sd-warning);
      font-variant-numeric: tabular-nums;
    }

    .entity-climate-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin: 6px 0;
    }

    .badge-climate-mode { font-weight: 700; }
    .badge-climate-heat { background: rgba(255, 61, 113, 0.12); color: var(--sd-error); border-color: rgba(255, 61, 113, 0.3); }
    .badge-climate-cool { background: rgba(0, 229, 255, 0.12); color: var(--sd-accent); border-color: rgba(0, 229, 255, 0.3); }
    .badge-climate-idle { background: rgba(255, 255, 255, 0.04); color: var(--sd-dim); }
    .badge-climate-off  { background: rgba(255, 255, 255, 0.02); color: var(--sd-dim); opacity: 0.7; }
    .badge-climate-dry  { background: rgba(255, 216, 102, 0.1); color: var(--sd-warning); }
    .badge-climate-fan  { background: rgba(0, 229, 255, 0.08); color: var(--sd-accent); }
    .badge-climate-preset   { background: rgba(191, 149, 249, 0.1); color: var(--sd-prompt); }
    .badge-climate-humidity  { background: rgba(0, 229, 255, 0.08); color: var(--sd-accent); }

    /* ── Media player card ─────────────────────────────────── */

    .entity-media-state {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0;
    }

    .entity-media-playback {
      font-size: 20px;
    }

    .entity-media-status {
      font-size: 14px;
      font-weight: 600;
      text-transform: capitalize;
    }

    .entity-media-nowplaying {
      margin: 6px 0;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 6px;
      border-left: 3px solid var(--sd-accent);
    }

    .entity-media-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--sd-fg);
    }

    .entity-media-artist {
      font-size: 12px;
      color: var(--sd-accent);
      margin-top: 2px;
    }

    .entity-media-album {
      font-size: 11px;
      color: var(--sd-dim);
      margin-top: 1px;
    }

    .entity-media-badges {
      display: flex;
      gap: 6px;
      margin: 6px 0;
      flex-wrap: wrap;
    }

    .badge-media-source { background: rgba(0, 229, 255, 0.08); color: var(--sd-accent); }
    .badge-media-app { background: rgba(191, 149, 249, 0.08); color: var(--sd-prompt); }

    /* ── Person card ───────────────────────────────────────── */

    .entity-person-location {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 8px 0;
    }

    .entity-person-location-icon {
      font-size: 28px;
    }

    .entity-person-location-label {
      font-size: 24px;
      font-weight: 700;
    }

    .entity-person-details {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin: 4px 0;
    }

    .entity-person-coords {
      font-size: 11px;
      color: var(--sd-dim);
      font-variant-numeric: tabular-nums;
    }

    .entity-person-gps {
      font-size: 11px;
      color: var(--sd-dim);
    }

    .entity-person-trackers {
      font-size: 11px;
      color: var(--sd-dim);
      margin: 4px 0;
    }

    .entity-person-trackers-label {
      color: var(--sd-dim);
    }

    .entity-person-trackers-value {
      color: var(--sd-fg);
    }

    .badge-person-source { background: rgba(0, 255, 159, 0.08); color: var(--sd-success); }

    /* ── Cover card ────────────────────────────────────────── */

    .entity-cover-badges {
      display: flex;
      gap: 6px;
      margin: 4px 0;
    }

    .badge-cover-type { background: rgba(0, 229, 255, 0.08); color: var(--sd-accent); }

    /* ── Automation / Script card ──────────────────────────── */

    .entity-automation-details {
      margin: 6px 0;
    }

    .entity-automation-triggered {
      font-size: 12px;
      margin-bottom: 6px;
    }

    .entity-automation-triggered-label {
      color: var(--sd-dim);
    }

    .entity-automation-triggered-value {
      color: var(--sd-fg);
      font-weight: 600;
    }

    .entity-automation-badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .badge-auto-mode { background: rgba(0, 229, 255, 0.08); color: var(--sd-accent); }
    .badge-auto-running { background: rgba(0, 255, 159, 0.12); color: var(--sd-success); animation: badge-pulse 2s infinite; }

    /* ── Weather card ──────────────────────────────────────── */

    .entity-weather-main {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 8px 0;
    }

    .entity-weather-condition-icon {
      font-size: 36px;
      color: var(--sd-warning);
    }

    .entity-weather-temp-block {
      display: flex;
      flex-direction: column;
    }

    .entity-weather-temp {
      font-size: 28px;
      font-weight: 700;
      color: var(--sd-fg);
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    .entity-weather-condition {
      font-size: 13px;
      color: var(--sd-dim);
      text-transform: capitalize;
      margin-top: 2px;
    }

    .entity-weather-feels {
      font-size: 11px;
      color: var(--sd-dim);
      margin-bottom: 6px;
    }

    .entity-weather-grid {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin: 6px 0;
    }

    .entity-weather-stat {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--sd-fg);
    }

    .entity-weather-stat-icon {
      color: var(--sd-dim);
      font-size: 14px;
    }

    .entity-weather-wind-dir {
      font-size: 10px;
      color: var(--sd-dim);
    }

    /* ── Calendar card ─────────────────────────────────────── */

    .entity-calendar-event {
      margin: 6px 0;
      padding: 6px 8px;
      background: rgba(0, 229, 255, 0.04);
      border-left: 2px solid var(--sd-accent);
      border-radius: 2px;
    }

    .entity-calendar-summary {
      font-weight: 600;
      color: var(--sd-fg);
      font-size: 13px;
    }

    .entity-calendar-desc {
      color: var(--sd-dim);
      font-size: 12px;
      margin-top: 2px;
    }

    .entity-calendar-time {
      color: var(--sd-dim);
      font-size: 12px;
      margin-top: 2px;
    }

    .entity-calendar-location {
      color: var(--sd-dim);
      font-size: 12px;
      margin-top: 2px;
    }

    .entity-calendar-hint {
      margin: 8px 0 4px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--sd-dim);
      background: rgba(0, 229, 255, 0.04);
      border-radius: 3px;
    }

    .entity-calendar-hint code {
      color: var(--sd-accent);
      font-family: var(--sd-font, 'Iosevka Nerd Font', monospace);
      font-size: 11px;
    }

    /* ── Calendar events (events() display) ──────────────────── */

    .calendar-events-container {
      margin: 4px 0;
    }

    .calendar-date-group {
      margin-bottom: 8px;
    }

    .calendar-date-header {
      font-weight: 600;
      font-size: 13px;
      color: var(--sd-accent);
      margin-bottom: 4px;
      padding: 2px 0;
      border-bottom: 1px solid rgba(0, 229, 255, 0.15);
    }

    .calendar-event-row {
      display: flex;
      gap: 8px;
      padding: 4px 0;
      min-height: 28px;
    }

    .calendar-event-dot-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 16px;
      flex-shrink: 0;
    }

    .calendar-event-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
    }

    .calendar-event-dot.dot-allday {
      background: var(--sd-accent);
    }

    .calendar-event-dot.dot-timed {
      background: var(--sd-success);
    }

    .calendar-event-line {
      width: 1px;
      flex: 1;
      background: rgba(0, 229, 255, 0.12);
      margin-top: 2px;
    }

    .calendar-event-body {
      flex: 1;
      min-width: 0;
    }

    .calendar-event-main {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }

    .calendar-event-summary {
      font-weight: 600;
      font-size: 13px;
      color: var(--sd-fg);
    }

    .calendar-event-time {
      font-size: 12px;
      color: var(--sd-dim);
    }

    .calendar-event-desc {
      font-size: 12px;
      color: var(--sd-dim);
      margin-top: 2px;
    }

    .calendar-event-location {
      font-size: 12px;
      color: var(--sd-dim);
      margin-top: 2px;
    }

    /* State colors */
    .state-success { color: var(--sd-success); }
    .state-error { color: var(--sd-error); }
    .state-warning { color: var(--sd-warning); }
    .state-accent { color: var(--sd-accent); }
    .state-dim { color: var(--sd-dim); }

    /* Key-value pairs */
    .kv-container {
      margin: 4px 0;
    }

    .kv-title {
      color: var(--sd-accent);
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 4px;
    }

    .kv-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .kv-table td {
      padding: 2px 8px 2px 0;
      border-bottom: 1px solid var(--sd-surface);
    }

    .kv-key {
      color: var(--sd-dim);
      white-space: nowrap;
      width: 1%;
    }

    .kv-value {
      color: var(--sd-fg);
      word-break: break-word;
    }

    /* Summary line */
    .summary-output {
      color: var(--sd-dim);
      font-size: 11px;
      padding: 2px 0;
      letter-spacing: 0.02em;
    }

    /* Copyable block */
    .copyable-container {
      position: relative;
      margin: 4px 0;
    }

    .copyable-content {
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--sd-surface);
      border: 1px solid var(--sd-border);
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 12px;
    }

    .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      background: var(--sd-border);
      color: var(--sd-dim);
      border: none;
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
      opacity: 0;
      transition: opacity 0.15s;
    }

    .copyable-container:hover .copy-btn,
    .output-entry:hover .copy-btn-inline {
      opacity: 1;
    }

    .copy-btn:hover {
      background: var(--sd-accent);
      color: var(--sd-bg);
    }

    .copy-btn-inline {
      position: absolute;
      top: 0;
      right: 0;
      background: var(--sd-surface, #111820);
      color: var(--sd-dim);
      border: 1px solid var(--sd-border, #1e2a3a);
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 2;
    }

    .copy-btn-inline:hover {
      color: var(--sd-accent);
    }

    /* HStack layout */
    .hstack {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .input-row {
      display: flex;
      align-items: center;
      padding: 8px 16px 12px;
      border-top: 1px solid var(--sd-border);
      gap: 4px;
      flex-shrink: 0;
    }

    .prompt-label {
      color: var(--sd-prompt);
      font-weight: 600;
      flex-shrink: 0;
      text-shadow: 0 0 6px rgba(191, 149, 249, 0.4);
    }

    #repl-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--sd-fg);
      font-family: inherit;
      font-size: inherit;
      caret-color: var(--sd-accent);
    }

    #repl-input::placeholder {
      color: var(--sd-dim);
      opacity: 0.5;
    }

    .loading {
      padding: 24px 16px;
      text-align: center;
      color: var(--sd-dim);
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .loading .spinner {
      display: inline-block;
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }

    /* Assistant response */
    .assistant-response {
      border-left: 2px solid var(--sd-accent);
      padding: 8px 12px;
      margin: 4px 0;
    }

    .assistant-header {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--sd-accent);
      font-size: 11px;
      margin-bottom: 6px;
    }

    .assistant-icon {
      font-size: 14px;
    }

    .assistant-agent {
      opacity: 0.7;
    }

    .assistant-body {
      white-space: pre-wrap;
      line-height: 1.5;
    }

    .assistant-snippets {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .assistant-snippet {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--sd-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .assistant-snippet-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--sd-dim);
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--sd-border);
    }

    .snippet-btn {
      background: transparent;
      color: var(--sd-dim);
      border: 1px solid var(--sd-border);
      border-radius: 3px;
      padding: 2px 8px;
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    }

    .snippet-btn:hover {
      color: var(--sd-accent);
      border-color: var(--sd-accent);
    }

    .snippet-run:hover {
      color: var(--sd-success);
      border-color: var(--sd-success);
    }

    .assistant-snippet-code {
      margin: 0;
      padding: 8px;
      font-size: 12px;
      overflow-x: auto;
    }

    /* ── Sparkline ────────────────────────────────────── */

    .sparkline-container {
      padding: 8px 0;
    }

    .sparkline-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .sparkline-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--sd-fg);
    }

    .sparkline-id {
      font-size: 11px;
      color: var(--sd-dim);
    }

    .sparkline-svg {
      display: block;
      width: 100%;
      max-width: 320px;
      height: 60px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.03);
    }

    .sparkline-line {
      fill: none;
      stroke: var(--sd-success);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }

    .sparkline-area {
      fill: rgba(0, 255, 159, 0.08);
    }

    .sparkline-dot {
      fill: var(--sd-success);
    }

    .sparkline-stats {
      display: flex;
      justify-content: space-between;
      max-width: 320px;
      font-size: 11px;
      color: var(--sd-dim);
      margin-top: 2px;
    }

    .sparkline-min { color: var(--sd-cyan); }
    .sparkline-current { color: var(--sd-success); font-weight: 600; }
    .sparkline-max { color: var(--sd-magenta); }

    /* ── Timeline ────────────────────────────────────── */

    .timeline-container {
      padding: 8px 0;
    }

    .timeline-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .timeline-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--sd-fg);
    }

    .timeline-id {
      font-size: 11px;
      color: var(--sd-dim);
    }

    .timeline-svg {
      display: block;
      width: 100%;
      max-width: 320px;
      height: 24px;
      border-radius: 4px;
      overflow: hidden;
    }

    .timeline-labels {
      display: flex;
      justify-content: space-between;
      align-items: center;
      max-width: 320px;
      font-size: 10px;
      color: var(--sd-dim);
      margin-top: 2px;
    }

    .timeline-legend {
      display: flex;
      gap: 8px;
    }

    .timeline-legend-item {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      color: var(--sd-prompt);
    }

    .timeline-legend-swatch {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
    }

    /* --- Logbook --- */

    .logbook-container {
      padding: 4px 0;
    }

    .logbook-entry {
      display: flex;
      align-items: flex-start;
      gap: 0;
      min-height: 32px;
    }

    .logbook-time {
      flex: 0 0 68px;
      font-size: 11px;
      color: var(--sd-dim);
      text-align: right;
      padding-right: 8px;
      padding-top: 3px;
      font-variant-numeric: tabular-nums;
    }

    .logbook-dot-col {
      flex: 0 0 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 5px;
    }

    .logbook-dot {
      display: block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--sd-dim);
      flex-shrink: 0;
    }

    .logbook-dot.dot-on {
      background: var(--sd-success);
      box-shadow: 0 0 6px rgba(0, 255, 159, 0.5);
    }

    .logbook-dot.dot-off {
      background: var(--sd-error);
    }

    .logbook-dot.dot-default {
      background: var(--sd-prompt);
    }

    .logbook-line {
      flex: 1;
      width: 2px;
      min-height: 12px;
      background: var(--sd-border);
    }

    .logbook-entry:last-child .logbook-line {
      display: none;
    }

    .logbook-body {
      flex: 1;
      padding: 2px 0 8px 8px;
      min-width: 0;
    }

    .logbook-main {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .logbook-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--sd-fg);
    }

    .logbook-message {
      font-size: 11px;
      color: var(--sd-cyan);
    }

    .logbook-context {
      font-size: 10px;
      color: var(--sd-dim);
      margin-top: 1px;
      font-style: italic;
    }

    /* --- Trace list --- */

    .trace-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .trace-entry {
      padding: 8px 10px;
      border: 1px solid var(--sd-border);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.02);
      font-family: var(--sd-font);
      font-size: 12px;
    }

    .trace-entry.trace-error {
      border-color: rgba(255, 61, 113, 0.4);
      background: rgba(255, 61, 113, 0.05);
    }

    .trace-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .trace-time {
      font-size: 11px;
      color: var(--sd-dim);
      min-width: 60px;
    }

    .trace-exec {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .trace-duration {
      font-size: 10px;
      color: var(--sd-dim);
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }

    .trace-automation {
      color: var(--sd-accent);
      font-size: 11px;
      margin-bottom: 2px;
    }

    .trace-trigger {
      color: var(--sd-warning);
      font-size: 11px;
      margin-bottom: 2px;
    }

    .trace-step {
      color: var(--sd-dim);
      font-size: 11px;
      margin-bottom: 2px;
    }

    .trace-error-msg {
      color: var(--sd-error);
      font-size: 11px;
      margin-top: 3px;
      padding: 3px 6px;
      background: rgba(255, 61, 113, 0.08);
      border-radius: 3px;
    }

    .badge-success {
      background: rgba(0, 255, 159, 0.12);
      color: var(--sd-success);
    }

    .badge-danger {
      background: rgba(255, 61, 113, 0.12);
      color: var(--sd-error);
    }

    .badge-active {
      background: rgba(0, 229, 255, 0.12);
      color: var(--sd-accent);
    }

    .badge-dim {
      background: rgba(74, 85, 104, 0.2);
      color: var(--sd-dim);
    }

    /* ── ECharts ────────────────────────────────────── */

    .echarts-container {
      width: 100%;
      min-height: 200px;
      margin: 6px 0;
      border-radius: 6px;
      border: 1px solid rgba(0, 229, 255, 0.15);
      background: rgba(0, 229, 255, 0.03);
    }

    .chart-title {
      font-family: var(--sd-font);
      font-size: 13px;
      font-weight: 600;
      color: var(--sd-accent);
      margin: 6px 0 2px 0;
      padding: 0 2px;
    }

    /* ── Service call confirmation gate ────────────────────────── */

    .service-confirm {
      margin: 6px 0;
      padding: 10px 12px;
      border: 1px solid rgba(255, 216, 102, 0.4);
      border-radius: 6px;
      background: rgba(255, 216, 102, 0.06);
      font-family: var(--sd-font);
    }

    .service-confirm-header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--sd-warning);
      margin-bottom: 8px;
    }

    .service-confirm-icon {
      font-size: 14px;
    }

    .service-confirm-detail code {
      font-size: 13px;
      font-weight: 600;
      color: var(--sd-fg);
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 6px;
      border-radius: 3px;
    }

    .service-confirm-data {
      margin: 8px 0;
      padding: 6px 8px;
      background: rgba(0, 0, 0, 0.15);
      border-radius: 4px;
      font-size: 11px;
    }

    .service-confirm-kv {
      display: flex;
      gap: 6px;
      padding: 1px 0;
    }

    .service-confirm-key {
      color: var(--sd-dim);
      min-width: 80px;
    }

    .service-confirm-val {
      color: var(--sd-fg);
      word-break: break-all;
    }

    .service-confirm-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }

    .service-confirm-btn {
      font-family: var(--sd-font);
      font-size: 11px;
      padding: 4px 14px;
      border-radius: 4px;
      border: 1px solid;
      cursor: pointer;
      transition: all 0.15s;
      font-weight: 600;
    }

    .service-confirm-btn.confirm {
      color: var(--sd-success);
      border-color: var(--sd-success);
      background: rgba(0, 255, 159, 0.08);
    }

    .service-confirm-btn.confirm:hover {
      background: rgba(0, 255, 159, 0.2);
    }

    .service-confirm-btn.deny {
      color: var(--sd-error);
      border-color: var(--sd-error);
      background: rgba(255, 61, 113, 0.08);
    }

    .service-confirm-btn.deny:hover {
      background: rgba(255, 61, 113, 0.2);
    }
  `;

  protected render() {
    if (this._config.mode === 'overlay') {
      return this._renderOverlayMode();
    }
    return this._renderEmbeddedMode();
  }

  /** Standard embedded card — renders inline in the dashboard. */
  private _renderEmbeddedMode() {
    const title = this._config.title || 'Signal Deck';

    return html`
      <ha-card style="--sd-card-height: ${this._config.height || '500px'}">
        ${this._renderHeader(title)}
        ${this._renderBody()}
      </ha-card>
    `;
  }

  /** Overlay mode — tiny launcher button + full-screen drop-down console. */
  private _renderOverlayMode() {
    const pos = this._config.overlay_position ?? 'top';
    const overlayHeight = this._config.overlay_height ?? '50vh';

    return html`
      <ha-card class="launcher-card">
        <button class="launcher-btn" @click=${this._toggleOverlay} title="Toggle Signal Deck (or press \`)">
          <span class="launcher-icon">⚡</span>
        </button>
      </ha-card>

      ${this._overlayOpen
        ? html`
            <div class="overlay-backdrop" @click=${this._closeOverlay}></div>
            <div
              class="overlay-panel overlay-${pos}"
              style="${pos !== 'full' ? `height: ${overlayHeight}` : ''}"
            >
              ${this._renderHeader(this._config.title || 'Signal Deck', true)}
              ${this._renderBody()}
            </div>
          `
        : nothing}
    `;
  }

  /** Render the card header bar. */
  private _renderHeader(title: string, showClose = false) {
    return html`
        <div class="header">
          <span class="header-icon">⚡</span>
          <span>${title}</span>
          <span class="header-by">by <a class="header-author" href="https://github.com/rsr5" target="_blank" rel="noopener noreferrer">rsr5</a></span>
          <span class="header-spacer"></span>
          <button
            class="header-btn ${this._showAnalyst ? 'active' : ''}"
            @click=${this._toggleAnalyst}
            title="${this._showAnalyst ? 'Hide' : 'Show'} Signal Analyst"
          >󰚩</button>
          ${showClose
            ? html`<button class="header-btn" @click=${this._closeOverlay} title="Close (Esc)">✕</button>`
            : nothing}
        </div>
    `;
  }

  /** Render the main shell body (output + input + analyst pane). */
  private _renderBody() {
    if (this._loading) {
      return html`<div class="loading"><span class="spinner">◉ Loading WASM engine…</span></div>`;
    }
    return html`
      <div class="deck-layout ${this._showAnalyst ? 'with-analyst' : ''}">
        <div class="shell-pane">
          <div id="output-container">
            ${this._outputs.map((entry) => this._renderEntry(entry))}
            ${this._pendingServiceCall ? this._renderServiceConfirm() : nothing}
          </div>

          <div class="input-row">
            <span class="prompt-label">${this._engine?.prompt() ?? '≫ '}</span>
            <input
              id="repl-input"
              type="text"
              .value=${this._inputValue}
              @input=${this._handleInput}
              @keydown=${this._handleKeyDown}
              placeholder="Type a command or :help"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
            />
          </div>
        </div>

        ${this._showAnalyst && this._engine
          ? html`
              <div class="resize-handle" @pointerdown=${this._onResizeStart}></div>
              <div class="analyst-pane" style="width:${this._analystWidth}px">
                <analyst-panel
                  .hass=${this.hass}
                  .engine=${this._engine}
                  .shellCallback=${this._shellCallback}
                  .agentId=${this._config.agent_id}
                  .confirmServiceCall=${this.requestServiceConfirmation.bind(this)}
                ></analyst-panel>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderEntry(entry: OutputEntry): TemplateResult {
    // Analyst code blocks: multi-line, syntax-highlighted.
    const isAnalyst = entry.input?.startsWith('[analyst] ');
    const inputText = isAnalyst ? entry.input!.slice('[analyst] '.length) : entry.input;
    const isMultiLine = inputText?.includes('\n');

    // Only show copy button for non-trivial output types.
    const showCopy = entry.spec.type !== 'error' && entry.spec.type !== 'help';

    return html`
      <div class="output-entry">
        ${entry.input
          ? isAnalyst && isMultiLine
            ? html`<div class="input-line">
                <span class="prompt">≫ </span><span class="analyst-tag">[analyst]</span>
              </div>
              <pre class="analyst-code-block"><code class="hljs">${unsafeHTML(highlightPython(inputText!))}</code></pre>`
            : html`<div class="input-line">
                <span class="prompt">≫ </span>${isAnalyst
                  ? html`<span class="analyst-tag">[analyst] </span><code class="user-input hljs">${unsafeHTML(highlightPython(inputText!))}</code>`
                  : html`<span class="user-input">${entry.input}</span>`}
              </div>`
          : nothing}
        ${this._renderSpec(entry.spec)}
        ${showCopy
          ? html`<button class="copy-btn-inline" @click=${() => this._copyToClipboard(this._specToCopyText(entry.spec))} title="Copy result">⧉</button>`
          : nothing}
      </div>
    `;
  }

  /** Render the service call confirmation card. */
  private _renderServiceConfirm(): TemplateResult {
    const p = this._pendingServiceCall!;
    const dataEntries = Object.entries(p.serviceData);

    return html`
      <div class="service-confirm">
        <div class="service-confirm-header">
          <span class="service-confirm-icon">⚠</span>
          <span>Confirm service call</span>
        </div>
        <div class="service-confirm-detail">
          <code>${p.domain}.${p.service}</code>
        </div>
        ${dataEntries.length > 0
          ? html`
              <div class="service-confirm-data">
                ${dataEntries.map(
                  ([k, v]) => html`<div class="service-confirm-kv">
                    <span class="service-confirm-key">${k}:</span>
                    <span class="service-confirm-val">${typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                  </div>`,
                )}
              </div>
            `
          : nothing}
        <div class="service-confirm-actions">
          <button class="service-confirm-btn confirm" @click=${this._confirmServiceCall}>
            ✓ Confirm
          </button>
          <button class="service-confirm-btn deny" @click=${this._denyServiceCall}>
            ✗ Deny
          </button>
        </div>
      </div>
    `;
  }

  private _renderSpec(spec: RenderSpec): TemplateResult {
    switch (spec.type) {
      case 'text':
        return html`<div class="text-output">${spec.content}</div>`;

      case 'error':
        return html`<div class="error-output">✗ ${spec.message}</div>`;

      case 'help':
        return html`<div class="help-output">${spec.content}</div>`;

      case 'summary':
        return html`<div class="summary-output">▸ ${spec.content}</div>`;

      case 'table':
        return this._renderPaginatedTable(spec);

      case 'entity_card':
        return this._renderEntityCard(spec);

      case 'key_value':
        return html`
          <div class="kv-container">
            ${spec.title ? html`<div class="kv-title">${spec.title}</div>` : nothing}
            <table class="kv-table">
              <tbody>
                ${spec.pairs.map(
                  ([key, value]) => html`
                    <tr>
                      <td class="kv-key">${key}</td>
                      <td class="kv-value">${value}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `;

      case 'badge':
        return html`<span class="badge badge-${spec.color}">${spec.label}</span>`;

      case 'copyable':
        return html`
          <div class="copyable-container">
            ${spec.label ? html`<div class="summary-output">${spec.label}</div>` : nothing}
            <div class="copyable-content">${spec.content}</div>
            <button class="copy-btn" @click=${() => this._copyToClipboard(spec.content)}>⧉ copy</button>
          </div>
        `;

      case 'vstack':
        return html`<div>${spec.children.map((child) => this._renderSpec(child))}</div>`;

      case 'hstack':
        return html`<div class="hstack">${spec.children.map((child) => this._renderSpec(child))}</div>`;

      case 'host_call':
        // Should not reach here — host calls are fulfilled before rendering.
        return html`<div class="error-output">Unfulfilled host call: ${spec.method}</div>`;

      case 'assistant':
        return html`
          <div class="assistant-response">
            <div class="assistant-header">
              <span class="assistant-icon">󰚩</span>
              <span class="assistant-agent">${spec.agent}</span>
            </div>
            <div class="assistant-body">${spec.response}</div>
            ${spec.snippets.length > 0
              ? html`
                  <div class="assistant-snippets">
                    ${spec.snippets.map(
                      (snippet, idx) => html`
                        <div class="assistant-snippet">
                          <div class="assistant-snippet-header">
                            <span>snippet ${idx + 1}</span>
                            <button class="snippet-btn" @click=${() => this._insertSnippet(snippet)}>⎘ insert</button>
                            <button class="snippet-btn snippet-run" @click=${() => this._runSnippet(snippet)}>▶ run</button>
                          </div>
                          <pre class="assistant-snippet-code">${snippet}</pre>
                        </div>
                      `,
                    )}
                  </div>
                `
              : nothing}
          </div>
        `;

      case 'sparkline':
        return this._renderSparkline(spec);

      case 'timeline':
        return this._renderTimeline(spec);

      case 'logbook':
        return this._renderLogbook(spec);

      case 'trace_list':
        return this._renderTraceList(spec);

      case 'echarts':
        return this._renderECharts(spec);

      case 'calendar_events':
        return this._renderCalendarEvents(spec);

      default:
        return html`<div class="text-output">[unknown spec type]</div>`;
    }
  }

  // --- Paginated table ---

  private static TABLE_PAGE_SIZE = 15;

  /** Get or create a stable ID for a table spec object. */
  private _getTableId(spec: object): string {
    let id = this._tableIdMap.get(spec);
    if (!id) {
      id = `t${this._tableIdCounter++}`;
      this._tableIdMap.set(spec, id);
    }
    return id;
  }

  private _renderPaginatedTable(spec: RenderSpec & { type: 'table' }): TemplateResult {
    const pageSize = SignalDeck.TABLE_PAGE_SIZE;
    const totalRows = spec.rows.length;

    // No pagination needed for small tables.
    if (totalRows <= pageSize) {
      return html`
        <table class="table-output">
          <thead>
            <tr>${spec.headers.map((h) => html`<th>${h}</th>`)}</tr>
          </thead>
          <tbody>
            ${spec.rows.map(
              (row) => html`<tr>${row.map((cell, ci) => html`<td>${this._renderCellValue(cell, ci, spec.headers)}</td>`)}</tr>`,
            )}
          </tbody>
        </table>
      `;
    }

    const tableId = this._getTableId(spec);
    const page = this._tablePages.get(tableId) ?? 0;
    const totalPages = Math.ceil(totalRows / pageSize);
    const start = page * pageSize;
    const end = Math.min(start + pageSize, totalRows);
    const pageRows = spec.rows.slice(start, end);

    return html`
      <table class="table-output">
        <thead>
          <tr>${spec.headers.map((h) => html`<th>${h}</th>`)}</tr>
        </thead>
        <tbody>
          ${pageRows.map(
            (row) => html`<tr>${row.map((cell, ci) => html`<td>${this._renderCellValue(cell, ci, spec.headers)}</td>`)}</tr>`,
          )}
        </tbody>
      </table>
      <div class="table-pager">
        <button
          class="pager-btn"
          ?disabled=${page === 0}
          @click=${() => this._setTablePage(tableId, page - 1)}
        >◂ prev</button>
        <span class="pager-info">${start + 1}–${end} of ${totalRows}</span>
        <button
          class="pager-btn"
          ?disabled=${page >= totalPages - 1}
          @click=${() => this._setTablePage(tableId, page + 1)}
        >next ▸</button>
      </div>
    `;
  }

  private _setTablePage(tableId: string, page: number): void {
    const next = new Map(this._tablePages);
    next.set(tableId, page);
    this._tablePages = next;
  }

  /** Render a rich entity card — delegates to domain-specific renderers. */
  private _renderEntityCard(spec: RenderSpec & { type: 'entity_card' }): TemplateResult {
    return renderEntityCard(spec);
  }

  /** Render a sparkline SVG for numeric time series. */
  private _renderSparkline(spec: RenderSpec & { type: 'sparkline' }): TemplateResult {
    const { points, min, max, current, name, unit, entity_id } = spec;
    const width = 320;
    const height = 60;
    const padding = 2;

    if (points.length < 2) {
      return html`<div class="text-output">Not enough data for sparkline.</div>`;
    }

    const tMin = points[0][0];
    const tMax = points[points.length - 1][0];
    const tRange = tMax - tMin || 1;
    const vRange = max - min || 1;

    // Scale points to SVG coordinates.
    const svgPoints = points.map(([t, v]) => {
      const x = padding + ((t - tMin) / tRange) * (width - 2 * padding);
      const y = padding + (1 - (v - min) / vRange) * (height - 2 * padding);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    // Build the filled area path.
    const linePath = `M ${svgPoints.join(' L ')}`;
    const areaPath = `${linePath} L ${(width - padding).toFixed(1)},${(height - padding).toFixed(1)} L ${padding.toFixed(1)},${(height - padding).toFixed(1)} Z`;

    const unitStr = unit ? ` ${unit}` : '';
    const minStr = `${min.toFixed(1)}${unitStr}`;
    const maxStr = `${max.toFixed(1)}${unitStr}`;
    const curStr = `${current.toFixed(1)}${unitStr}`;

    return html`
      <div class="sparkline-container">
        <div class="sparkline-header">
          <span class="sparkline-name">${name}</span>
          <span class="sparkline-id">${entity_id}</span>
        </div>
        <svg
          class="sparkline-svg"
          viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none"
          width="${width}"
          height="${height}"
        >
          <path d="${areaPath}" class="sparkline-area" />
          <polyline
            points="${svgPoints.join(' ')}"
            class="sparkline-line"
          />
          <!-- Current value dot -->
          <circle
            cx="${svgPoints[svgPoints.length - 1].split(',')[0]}"
            cy="${svgPoints[svgPoints.length - 1].split(',')[1]}"
            r="2.5"
            class="sparkline-dot"
          />
        </svg>
        <div class="sparkline-stats">
          <span class="sparkline-min">▾ ${minStr}</span>
          <span class="sparkline-current">● ${curStr}</span>
          <span class="sparkline-max">▴ ${maxStr}</span>
        </div>
      </div>
    `;
  }

  /** Render a HA-style state timeline SVG. */
  private _renderTimeline(spec: RenderSpec & { type: 'timeline' }): TemplateResult {
    const { segments, start_time, end_time, name, entity_id } = spec;
    const width = 320;
    const height = 24;
    const totalMs = end_time - start_time || 1;

    if (segments.length === 0) {
      return html`<div class="text-output">No timeline data.</div>`;
    }

    // Format time range for display.
    const fmtTime = (ms: number) => {
      const d = new Date(ms);
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    };

    return html`
      <div class="timeline-container">
        <div class="timeline-header">
          <span class="timeline-name">${name}</span>
          <span class="timeline-id">${entity_id}</span>
        </div>
        <svg
          class="timeline-svg"
          viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none"
          width="${width}"
          height="${height}"
        >
          ${segments.map(([segStart, segEnd, , color]) => {
            const x = ((segStart - start_time) / totalMs) * width;
            const w = Math.max(((segEnd - segStart) / totalMs) * width, 1);
            return svg`<rect x="${x}" y="0" width="${w}" height="${height}" fill="${color}" rx="2" />`;
          })}
        </svg>
        <div class="timeline-labels">
          <span>${fmtTime(start_time)}</span>
          <div class="timeline-legend">
            ${this._timelineLegend(segments)}
          </div>
          <span>${fmtTime(end_time)}</span>
        </div>
      </div>
    `;
  }

  /** Build a compact legend for timeline states. */
  private _timelineLegend(
    segments: [number, number, string, string][],
  ): TemplateResult {
    // Deduplicate states.
    const seen = new Map<string, string>();
    for (const [, , state, color] of segments) {
      if (!seen.has(state)) seen.set(state, color);
    }
    return html`${[...seen.entries()].map(
      ([state, color]) =>
        html`<span class="timeline-legend-item">
          <span class="timeline-legend-swatch" style="background:${color}"></span>${state}
        </span>`,
    )}`;
  }

  /** Render a rich logbook display — vertical timeline of state changes with context. */
  private _renderLogbook(spec: RenderSpec & { type: 'logbook' }): TemplateResult {
    const { entries, entity_id } = spec;

    if (entries.length === 0) {
      return html`<div class="text-output">No logbook entries for ${entity_id}.</div>`;
    }

    return html`
      <div class="logbook-container">
        ${entries.map((entry) => {
          const time = this._formatLogbookTime(entry.when);
          const stateClass = entry.state ? this._stateBadgeClass(entry.state) : null;
          const context = this._formatLogbookContext(entry);

          return html`
            <div class="logbook-entry">
              <div class="logbook-time">${time}</div>
              <div class="logbook-dot-col">
                <span class="logbook-dot ${entry.state === 'on' ? 'dot-on' : entry.state === 'off' ? 'dot-off' : 'dot-default'}"></span>
                <span class="logbook-line"></span>
              </div>
              <div class="logbook-body">
                <div class="logbook-main">
                  <span class="logbook-name">${entry.name}</span>
                  ${entry.state != null
                    ? html`<span class="badge ${stateClass ?? ''}">${entry.state}</span>`
                    : nothing}
                  ${entry.message ? html`<span class="logbook-message">${entry.message}</span>` : nothing}
                </div>
                ${context ? html`<div class="logbook-context">${context}</div>` : nothing}
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }

  /** Format a logbook timestamp for display (HH:MM or relative). */
  private _formatLogbookTime(isoString: string): string {
    try {
      const d = new Date(isoString);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMin = Math.floor(diffMs / 60000);

      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m ago`;

      const diffHours = Math.floor(diffMin / 60);
      if (diffHours < 24) {
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      }

      // More than a day — show date + time.
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      const day = d.getDate().toString().padStart(2, '0');
      return `${month}-${day} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    } catch {
      return isoString;
    }
  }

  /** Format the context line explaining WHY a logbook entry happened. */
  private _formatLogbookContext(entry: {
    context_user?: string | null;
    context_domain?: string | null;
    context_service?: string | null;
    context_entity?: string | null;
    context_entity_name?: string | null;
    context_event?: string | null;
  }): string | null {
    const parts: string[] = [];

    if (entry.context_domain && entry.context_service) {
      parts.push(`via ${entry.context_domain}.${entry.context_service}`);
    } else if (entry.context_domain) {
      parts.push(`via ${entry.context_domain}`);
    }

    if (entry.context_entity_name) {
      parts.push(`by ${entry.context_entity_name}`);
    } else if (entry.context_entity) {
      parts.push(`by ${entry.context_entity}`);
    }

    if (entry.context_user) {
      parts.push(`(${entry.context_user})`);
    }

    if (entry.context_event) {
      parts.push(`[${entry.context_event}]`);
    }

    return parts.length > 0 ? parts.join(' ') : null;
  }

  /** Render a rich calendar events display — upcoming events grouped by date. */
  private _renderCalendarEvents(spec: RenderSpec & { type: 'calendar_events' }): TemplateResult {
    const { entries, entity_id } = spec;

    if (entries.length === 0) {
      return html`<div class="text-output">No upcoming events for ${entity_id}.</div>`;
    }

    // Group events by date.
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) {
      const dateKey = this._calendarDateKey(entry.start);
      const list = grouped.get(dateKey) ?? [];
      list.push(entry);
      grouped.set(dateKey, list);
    }

    return html`
      <div class="calendar-events-container">
        ${[...grouped.entries()].map(([dateKey, dayEntries]) => {
          const dateLabel = this._formatCalendarDate(dateKey);
          return html`
            <div class="calendar-date-group">
              <div class="calendar-date-header">📅 ${dateLabel}</div>
              ${dayEntries.map((entry) => html`
                <div class="calendar-event-row">
                  <div class="calendar-event-dot-col">
                    <span class="calendar-event-dot ${entry.all_day ? 'dot-allday' : 'dot-timed'}"></span>
                    <span class="calendar-event-line"></span>
                  </div>
                  <div class="calendar-event-body">
                    <div class="calendar-event-main">
                      <span class="calendar-event-summary">${entry.summary}</span>
                      ${entry.all_day
                        ? html`<span class="badge badge-dim">all day</span>`
                        : html`<span class="calendar-event-time">${this._formatCalendarTime(entry.start)}${entry.end ? ` → ${this._formatCalendarTime(entry.end)}` : ''}</span>`}
                    </div>
                    ${entry.description
                      ? html`<div class="calendar-event-desc">${entry.description}</div>`
                      : nothing}
                    ${entry.location
                      ? html`<div class="calendar-event-location">📍 ${entry.location}</div>`
                      : nothing}
                  </div>
                </div>
              `)}
            </div>
          `;
        })}
      </div>
    `;
  }

  /** Extract a date key (YYYY-MM-DD) from an ISO datetime or date string. */
  private _calendarDateKey(dateStr: string | null): string {
    if (!dateStr) return 'unknown';
    return dateStr.slice(0, 10);
  }

  /** Format a date key into a friendly label (e.g. "Tue 24 Feb" or "Today"). */
  private _formatCalendarDate(dateKey: string): string {
    try {
      const d = new Date(dateKey + 'T00:00:00');
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);

      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Tomorrow';

      const dayName = d.toLocaleDateString('en-GB', { weekday: 'short' });
      const day = d.getDate();
      const month = d.toLocaleDateString('en-GB', { month: 'short' });
      return `${dayName} ${day} ${month}`;
    } catch {
      return dateKey;
    }
  }

  /** Format a calendar time from an ISO datetime string. */
  private _formatCalendarTime(dateStr: string | null): string {
    if (!dateStr || dateStr.length <= 10) return '';
    try {
      const d = new Date(dateStr);
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    } catch {
      return dateStr;
    }
  }

  /** Render a rich trace list — automation execution trace cards. */
  private _renderTraceList(spec: RenderSpec & { type: 'trace_list' }): TemplateResult {
    const { entries } = spec;

    if (entries.length === 0) {
      return html`<div class="text-output">No traces found.</div>`;
    }

    return html`
      <div class="trace-container">
        ${entries.map((entry) => {
          const time = this._formatLogbookTime(entry.start);
          const duration = this._formatTraceDuration(entry.start, entry.finish);
          const execClass = this._traceExecClass(entry.execution ?? entry.state);
          const hasError = !!entry.error;

          return html`
            <div class="trace-entry ${hasError ? 'trace-error' : ''}">
              <div class="trace-header">
                <span class="trace-time">${time}</span>
                <span class="trace-exec badge ${execClass}">${entry.execution ?? entry.state}</span>
                ${duration ? html`<span class="trace-duration">${duration}</span>` : nothing}
              </div>
              ${entry.automation
                ? html`<div class="trace-automation">󰒓 ${entry.automation}</div>`
                : nothing}
              ${entry.trigger
                ? html`<div class="trace-trigger">⚡ ${entry.trigger}</div>`
                : nothing}
              ${entry.last_step
                ? html`<div class="trace-step">→ ${entry.last_step}</div>`
                : nothing}
              ${entry.error
                ? html`<div class="trace-error-msg">✗ ${entry.error}</div>`
                : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }

  /** Format trace duration from start/finish ISO strings. */
  private _formatTraceDuration(start: string, finish: string | null): string | null {
    if (!finish) return null;
    try {
      const startMs = new Date(start).getTime();
      const finishMs = new Date(finish).getTime();
      const diffMs = finishMs - startMs;
      if (diffMs < 1000) return `${diffMs}ms`;
      if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
      return `${(diffMs / 60000).toFixed(1)}m`;
    } catch {
      return null;
    }
  }

  /** Map trace execution state to a CSS badge class. */
  private _traceExecClass(execution: string): string {
    switch (execution) {
      case 'finished':
        return 'badge-success';
      case 'running':
        return 'badge-active';
      case 'error':
      case 'aborted':
        return 'badge-danger';
      case 'stopped':
        return 'badge-dim';
      default:
        return 'badge-dim';
    }
  }

  // --- ECharts rendering ---

  /** Counter for unique chart container IDs. */
  private _chartCounter = 0;

  /** Render an ECharts spec — creates a container and initialises ECharts after render. */
  private _renderECharts(spec: RenderSpec & { type: 'echarts' }): TemplateResult {
    const chartId = `sd-chart-${++this._chartCounter}`;
    const height = spec.height || 300;

    // Schedule ECharts init after Lit renders the DOM.
    this.updateComplete.then(() => {
      const container = this.shadowRoot?.getElementById(chartId);
      if (!container) return;
      const chart = echarts.init(container);
      // Apply Signal Deck theme colours.
      const sdFont = { color: '#a0aec0', fontFamily: 'Iosevka, monospace', fontSize: 12 };
      // Deep-theme series labels (pie labels, bar labels, etc.).
      const themedSeries = Array.isArray(spec.option.series)
        ? (spec.option.series as Record<string, unknown>[]).map((s) => ({
            ...s,
            label: { ...sdFont, ...(s.label as Record<string, unknown> ?? {}) },
          }))
        : spec.option.series;
      const themedOption = {
        ...spec.option,
        backgroundColor: 'transparent',
        textStyle: sdFont,
        legend: {
          ...(spec.option.legend as Record<string, unknown> ?? {}),
          textStyle: sdFont,
        },
        series: themedSeries,
      };
      chart.setOption(themedOption as echarts.EChartsCoreOption);
      // Resize on container resize.
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(container);
    });

    return html`
      ${spec.title ? html`<div class="chart-title">${spec.title}</div>` : nothing}
      <div id="${chartId}" class="echarts-container" style="height: ${height}px;"></div>
    `;
  }

  /** Copy text to clipboard. */
  private async _copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers.
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

  /** Convert a RenderSpec to plain text for clipboard copy. */
  private _specToCopyText(spec: RenderSpec): string {
    switch (spec.type) {
      case 'text':
        return spec.content;
      case 'error':
        return `Error: ${spec.message}`;
      case 'summary':
        return spec.content;
      case 'help':
        return spec.content;
      case 'badge':
        return spec.label;
      case 'copyable':
        return spec.content;
      case 'table': {
        const header = spec.headers.join('\t');
        const rows = spec.rows.map((r) => r.join('\t')).join('\n');
        return `${header}\n${rows}`;
      }
      case 'entity_card':
        return `${spec.entity_id}\t${spec.state}${spec.unit ? ' ' + spec.unit : ''}\t${spec.name}`;
      case 'key_value':
        return spec.pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
      case 'sparkline':
        return `${spec.entity_id}\tmin=${spec.min}\tcurrent=${spec.current}\tmax=${spec.max}${spec.unit ? ' ' + spec.unit : ''}`;
      case 'timeline': {
        const states = [...new Set(spec.segments.map((s: [number, number, string, string]) => s[2]))];
        return `${spec.entity_id}\tstates: ${states.join(', ')}`;
      }
      case 'logbook':
        return spec.entries.map((e) => `${e.when}\t${e.name}\t${e.state ?? ''}`).join('\n');
      case 'trace_list':
        return spec.entries.map((e) => `${e.start}\t${e.automation ?? ''}\t${e.execution ?? e.state}`).join('\n');
      case 'echarts':
        return `Chart${spec.title ? `: ${spec.title}` : ''} (ECharts — interactive chart rendered in card)`;
      case 'calendar_events':
        return spec.entries.map((e) => `${e.start ?? ''}\t${e.summary}${e.location ? `\t${e.location}` : ''}`).join('\n');
      case 'vstack':
        return spec.children.map((c) => this._specToCopyText(c)).join('\n');
      case 'hstack':
        return spec.children.map((c) => this._specToCopyText(c)).join('\t');
      default:
        return JSON.stringify(spec);
    }
  }

  /** Insert an assistant snippet into the input field without executing. */
  private _insertSnippet(snippet: string): void {
    this._inputValue = snippet;
  }

  /** Run an assistant snippet as if the user typed and submitted it. */
  private async _runSnippet(snippet: string): Promise<void> {
    this._inputValue = snippet;
    await this._submitInput();
  }

  /**
   * Render a table cell value — wraps state values in colored badges.
   */
  private _renderCellValue(
    value: string,
    colIdx: number,
    headers: string[],
  ): TemplateResult | string {
    // Only badge the "state" column.
    const header = headers[colIdx]?.toLowerCase();
    if (header !== 'state') {
      return value;
    }

    const badgeClass = this._stateBadgeClass(value);
    if (!badgeClass) {
      return value;
    }

    return html`<span class="badge ${badgeClass}">${value}</span>`;
  }

  /** Map a state string to a CSS badge class. */
  private _stateBadgeClass(state: string): string | null {
    const s = state.toLowerCase();

    // Known keyword states.
    const keywordMap: Record<string, string> = {
      on: 'badge-on',
      off: 'badge-off',
      open: 'badge-open',
      opening: 'badge-open',
      closed: 'badge-closed',
      closing: 'badge-closed',
      locked: 'badge-locked',
      locking: 'badge-locked',
      unlocked: 'badge-unlocked',
      unlocking: 'badge-unlocked',
      home: 'badge-home',
      not_home: 'badge-away',
      away: 'badge-away',
      active: 'badge-active',
      idle: 'badge-idle',
      standby: 'badge-standby',
      paused: 'badge-paused',
      playing: 'badge-playing',
      unavailable: 'badge-unavailable',
      unknown: 'badge-unknown',
      jammed: 'badge-jammed',
      problem: 'badge-problem',
      disarmed: 'badge-disarmed',
      armed_home: 'badge-armed_home',
      armed_away: 'badge-armed_away',
      armed_night: 'badge-armed_night',
      triggered: 'badge-triggered',
      pending: 'badge-pending',
      above_horizon: 'badge-on',
      below_horizon: 'badge-off',
      heating: 'badge-on',
      cooling: 'badge-active',
      heat: 'badge-on',
      cool: 'badge-active',
      auto: 'badge-active',
      dry: 'badge-idle',
      fan_only: 'badge-idle',
      cleaning: 'badge-active',
      returning: 'badge-idle',
      docked: 'badge-off',
      charging: 'badge-active',
      discharging: 'badge-idle',
      detected: 'badge-on',
      clear: 'badge-off',
      connected: 'badge-on',
      disconnected: 'badge-off',
    };

    if (keywordMap[s]) {
      return keywordMap[s];
    }

    // Numeric states (temperatures, percentages, etc.) get a numeric badge.
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      return 'badge-numeric';
    }

    return null;
  }
}

// --- Lovelace card registration ---

declare global {
  interface HTMLElementTagNameMap {
    'signal-deck': SignalDeck;
  }
  interface Window {
    customCards?: Array<{ type: string; name: string; description: string; preview: boolean }>;
  }
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'signal-deck',
  name: 'Signal Deck',
  description: 'The oscilloscope for Home Assistant — a safe Python REPL for debugging and observability',
  preview: true,
});
