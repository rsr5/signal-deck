/**
 * WASM engine bridge — loads the shell engine WASM and provides a typed wrapper.
 */

import initWasm, { WasmShellEngine } from '../../pkg/signal_deck_engine.js';
import type { RenderSpec } from '../types/index.js';

/** Replaced at build time by rollup-plugin-replace with a short hash. */
declare const __BUILD_HASH__: string;

let initialized = false;

/**
 * Initialize the WASM module. Safe to call multiple times — only runs once.
 */
export async function initEngine(): Promise<void> {
  if (initialized) return;

  // Build a cache-busting URL so the browser fetches a fresh WASM after rebuilds.
  // __BUILD_HASH__ is replaced at build time by rollup-plugin-replace.
  const wasmUrl = new URL('signal_deck_engine_bg.wasm', import.meta.url);
  wasmUrl.searchParams.set('v', __BUILD_HASH__);

  await initWasm(wasmUrl);
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
