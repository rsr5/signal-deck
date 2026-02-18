import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import replace from '@rollup/plugin-replace';
import serve from 'rollup-plugin-serve';
import { copyFileSync, mkdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

const dev = process.env.ROLLUP_WATCH === 'true';

// Copy WASM file to dist so it can be loaded at runtime.
// wasm-pack outputs to crates/shell-engine/pkg/ — sync it to both
// the root pkg/ (for TS imports) and dist/ (for runtime loading).
function copyWasm() {
  return {
    name: 'copy-wasm',
    buildStart() {
      mkdirSync('dist', { recursive: true });
      // Sync from wasm-pack output to root pkg/ first.
      const wasmSrc = 'crates/shell-engine/pkg/signal_deck_engine_bg.wasm';
      const jsSrc = 'crates/shell-engine/pkg/signal_deck_engine.js';
      const dtsSrc = 'crates/shell-engine/pkg/signal_deck_engine.d.ts';
      const bgDtsSrc = 'crates/shell-engine/pkg/signal_deck_engine_bg.wasm.d.ts';
      try { copyFileSync(wasmSrc, 'pkg/signal_deck_engine_bg.wasm'); } catch (_) {}
      try { copyFileSync(jsSrc, 'pkg/signal_deck_engine.js'); } catch (_) {}
      try { copyFileSync(dtsSrc, 'pkg/signal_deck_engine.d.ts'); } catch (_) {}
      try { copyFileSync(bgDtsSrc, 'pkg/signal_deck_engine_bg.wasm.d.ts'); } catch (_) {}
      // Copy WASM to dist for runtime.
      copyFileSync(
        'pkg/signal_deck_engine_bg.wasm',
        'dist/signal_deck_engine_bg.wasm',
      );
    },
  };
}

// Compute a short content hash of the WASM binary for cache-busting.
function wasmHash() {
  try {
    const buf = readFileSync('pkg/signal_deck_engine_bg.wasm');
    return createHash('md5').update(buf).digest('hex').slice(0, 8);
  } catch (_) {
    return Date.now().toString(36);
  }
}

export default {
  input: 'src/signal-deck.ts',
  output: {
    file: 'dist/signal-deck.js',
    format: 'es',
    sourcemap: dev,
  },
  plugins: [
    copyWasm(),
    replace({
      'process.env.NODE_ENV': JSON.stringify('production'),
      '__BUILD_HASH__': JSON.stringify(wasmHash()),
      preventAssignment: true,
    }),
    resolve(),
    commonjs(),
    typescript(),
    !dev && terser(),
    dev &&
      serve({
        contentBase: 'dist',
        port: 5050,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      }),
  ].filter(Boolean),
};
