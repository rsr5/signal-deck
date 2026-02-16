/**
 * WASM engine bridge — loads the shell engine WASM and provides a typed wrapper.
 */

import initWasm, { WasmShellEngine } from '../../pkg/signal_deck_engine.js';
import type { RenderSpec } from '../types/index.js';

let initialized = false;

/**
 * Initialize the WASM module. Safe to call multiple times — only runs once.
 */
export async function initEngine(): Promise<void> {
  if (initialized) return;

  // When using @rollup/plugin-wasm with sync inlining, the WASM bytes
  // are embedded in the JS bundle. We import and init them here.
  await initWasm();
  initialized = true;
}

/**
 * Typed wrapper around the WASM shell engine.
 */
export class ShellEngine {
  private engine: WasmShellEngine;

  constructor() {
    this.engine = new WasmShellEngine();
  }

  /** Process user input. Returns a parsed render spec. */
  eval(input: string): RenderSpec {
    const json = this.engine.eval(input);
    return JSON.parse(json) as RenderSpec;
  }

  /** Fulfill a host call with JSON data. Returns the resulting render spec. */
  fulfillHostCall(callId: string, data: string): RenderSpec {
    const json = this.engine.fulfill_host_call(callId, data);
    return JSON.parse(json) as RenderSpec;
  }

  /** Get the current prompt string. */
  prompt(): string {
    return this.engine.prompt();
  }

  /** Get session history. */
  history(): string[] {
    return JSON.parse(this.engine.history()) as string[];
  }

  /** Free WASM memory. */
  dispose(): void {
    this.engine.free();
  }
}
