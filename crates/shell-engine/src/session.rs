use monty::{MontyRepl, NoLimitTracker, ReplSnapshot};

use crate::monty_runtime;

/// Session state — history, variables, counters, REPL.
/// Owned by the shell engine, persists for the lifetime of the card.
pub struct Session {
    /// Command history (most recent last).
    history_entries: Vec<String>,

    /// Monotonic counter for generating unique host call IDs.
    call_counter: u64,

    /// A paused Monty execution waiting for a host call to be fulfilled.
    /// Stored here so we can resume when `fulfill_host_call` is called.
    pending_monty: Option<PendingMonty>,

    /// The stateful Monty REPL session.
    /// `Some` when idle (ready to start a new snippet).
    /// `None` when a snippet is in-flight (consumed by `start()`).
    pub(crate) repl: Option<MontyRepl<NoLimitTracker>>,
}

/// A Monty execution that paused at an external function call.
pub struct PendingMonty {
    /// The host call ID this snapshot is waiting on.
    pub call_id: String,
    /// The frozen REPL execution state.
    pub snapshot: ReplSnapshot<NoLimitTracker>,
    /// Print output captured before the pause.
    pub output_so_far: String,
    /// The original user snippet (for display/debugging).
    pub original_snippet: String,
    /// The host call method name (e.g. "get_state", "get_states") —
    /// used to decide how to convert the response back to MontyObject.
    pub method: String,
    /// The host call parameters — used for auto-visualization context.
    pub params: serde_json::Value,
}

impl Session {
    pub fn new() -> Self {
        // Initialise a fresh Monty REPL with all HA external functions registered.
        let repl = monty_runtime::init_repl("").ok();
        Self {
            history_entries: Vec::new(),
            call_counter: 0,
            pending_monty: None,
            repl,
        }
    }

    /// Record a line of input in history.
    pub fn push_history(&mut self, input: &str) {
        let trimmed = input.trim();
        if !trimmed.is_empty() {
            self.history_entries.push(trimmed.to_string());
        }
    }

    /// Get history entries.
    pub fn history(&self) -> &[String] {
        &self.history_entries
    }

    /// Generate a unique host call ID.
    pub fn next_call_id(&mut self) -> String {
        self.call_counter += 1;
        format!("call_{}", self.call_counter)
    }

    /// Store a paused Monty execution.
    pub fn store_pending_monty(&mut self, pending: PendingMonty) {
        self.pending_monty = Some(pending);
    }

    /// Take a pending Monty execution matching the given call ID.
    pub fn take_pending_monty(&mut self, call_id: &str) -> Option<PendingMonty> {
        if self.pending_monty.as_ref().map(|p| p.call_id.as_str()) == Some(call_id) {
            self.pending_monty.take()
        } else {
            None
        }
    }

    /// Check if there is a pending Monty execution for a given call ID.
    pub fn has_pending_monty(&self, call_id: &str) -> bool {
        self.pending_monty.as_ref().map(|p| p.call_id.as_str()) == Some(call_id)
    }

    /// Take the REPL out of the session (for starting a new snippet).
    /// Returns `None` if the REPL is currently in-flight or failed to init.
    pub fn take_repl(&mut self) -> Option<MontyRepl<NoLimitTracker>> {
        self.repl.take()
    }

    /// Store the REPL back into the session after a snippet completes.
    pub fn store_repl(&mut self, repl: MontyRepl<NoLimitTracker>) {
        self.repl = Some(repl);
    }

    /// Check if the REPL is available (idle, ready for a new snippet).
    pub fn has_repl(&self) -> bool {
        self.repl.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history() {
        let mut session = Session::new();
        session.push_history("ha.state('sensor.temp')");
        session.push_history("%ls binary_sensor");
        assert_eq!(session.history().len(), 2);
        assert_eq!(session.history()[0], "ha.state('sensor.temp')");
    }

    #[test]
    fn test_empty_input_not_recorded() {
        let mut session = Session::new();
        session.push_history("  ");
        session.push_history("");
        assert_eq!(session.history().len(), 0);
    }

    #[test]
    fn test_call_ids_increment() {
        let mut session = Session::new();
        assert_eq!(session.next_call_id(), "call_1");
        assert_eq!(session.next_call_id(), "call_2");
        assert_eq!(session.next_call_id(), "call_3");
    }

    #[test]
    fn test_repl_initialized() {
        let session = Session::new();
        assert!(session.has_repl());
    }

    #[test]
    fn test_take_repl() {
        let mut session = Session::new();
        assert!(session.has_repl());
        let repl = session.take_repl();
        assert!(repl.is_some());
        assert!(!session.has_repl());
    }

    #[test]
    fn test_store_repl() {
        let mut session = Session::new();
        let repl = session.take_repl().unwrap();
        assert!(!session.has_repl());
        session.store_repl(repl);
        assert!(session.has_repl());
    }
}
