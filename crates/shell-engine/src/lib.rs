mod engine;
mod icons;
mod magic;
mod monty_runtime;
mod render;
mod session;

pub use engine::ShellEngine;
pub use render::RenderSpec;

use wasm_bindgen::prelude::*;

/// The WASM-exposed shell engine instance.
/// TypeScript creates one of these per card and sends user input to it.
#[wasm_bindgen]
pub struct WasmShellEngine {
    inner: ShellEngine,
}

#[wasm_bindgen]
impl WasmShellEngine {
    /// Create a new shell engine.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: ShellEngine::new(),
        }
    }

    /// Process a line of user input and return a JSON render spec.
    ///
    /// The returned JSON is either:
    /// - A render spec (type: "text", "table", "error", etc.)
    /// - A host call request (type: "host_call") that TypeScript must fulfil
    #[wasm_bindgen]
    pub fn eval(&mut self, input: &str) -> String {
        let spec = self.inner.eval(input);
        serde_json::to_string(&spec).unwrap_or_else(|e| {
            serde_json::to_string(&RenderSpec::error(format!("Serialization error: {e}"))).unwrap()
        })
    }

    /// Feed the result of a host call back into the engine.
    /// `call_id` matches the id from the host_call request.
    /// `data` is the JSON response from TypeScript.
    #[wasm_bindgen]
    pub fn fulfill_host_call(&mut self, call_id: &str, data: &str) -> String {
        let spec = self.inner.fulfill_host_call(call_id, data);
        serde_json::to_string(&spec).unwrap_or_else(|e| {
            serde_json::to_string(&RenderSpec::error(format!("Serialization error: {e}"))).unwrap()
        })
    }

    /// Get the current prompt string (e.g. ">>> " or "... ").
    #[wasm_bindgen]
    pub fn prompt(&self) -> String {
        self.inner.prompt()
    }

    /// Get session history as JSON array of strings.
    #[wasm_bindgen]
    pub fn history(&self) -> String {
        serde_json::to_string(&self.inner.session.history()).unwrap()
    }
}
