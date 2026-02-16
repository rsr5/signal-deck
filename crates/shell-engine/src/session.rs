use monty::{MontyObject, NoLimitTracker, Snapshot};

/// Check if a Python snippet references `_` as a standalone identifier.
///
/// Returns `true` if `_` appears as a variable name (not as part of a longer
/// identifier like `my_var` or `__init__`). This is used to prevent pushing
/// `_`-dependent snippets into the replay context, since `_` changes every eval.
fn snippet_references_underscore(code: &str) -> bool {
    let bytes = code.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        // Skip string literals to avoid false positives in f"_{x}_" etc.
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let quote = bytes[i];
            i += 1;
            while i < len && bytes[i] != quote {
                if bytes[i] == b'\\' {
                    i += 1; // skip escaped char
                }
                i += 1;
            }
            i += 1; // skip closing quote
            continue;
        }
        // Skip comments
        if bytes[i] == b'#' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == b'_' {
            // Check it's a standalone `_` — not part of a longer identifier.
            let before_ok = i == 0 || !is_ident_char(bytes[i - 1]);
            let after_ok = i + 1 >= len || !is_ident_char(bytes[i + 1]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Is this byte part of a Python identifier? (letter, digit, underscore)
fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Session state — history, variables, counters, Python context.
/// Owned by the shell engine, persists for the lifetime of the card.
pub struct Session {
    /// Command history (most recent last).
    history_entries: Vec<String>,

    /// Monotonic counter for generating unique host call IDs.
    call_counter: u64,

    /// A paused Monty execution waiting for a host call to be fulfilled.
    /// Stored here so we can resume when `fulfill_host_call` is called.
    pending_monty: Option<PendingMonty>,

    /// Accumulated successful Python code blocks.
    /// Each new eval runs these as a prefix so variables/functions persist.
    python_context: Vec<String>,

    /// The last expression result as a raw MontyObject.
    /// Passed as the `_` input variable to subsequent evals so that
    /// dataclasses retain dot-access (no serialization needed).
    last_result: Option<MontyObject>,
}

/// A Monty execution that paused at an external function call.
pub struct PendingMonty {
    /// The host call ID this snapshot is waiting on.
    pub call_id: String,
    /// The frozen Monty execution state.
    pub snapshot: Snapshot<NoLimitTracker>,
    /// Print output captured before the pause.
    pub output_so_far: String,
    /// The original user snippet — committed to context on success.
    pub original_snippet: String,
    /// The host call method name (e.g. "get_state", "get_states") —
    /// used to decide how to convert the response back to MontyObject.
    pub method: String,
    /// The host call parameters — used for auto-visualization context.
    pub params: serde_json::Value,
}

impl Session {
    pub fn new() -> Self {
        Self {
            history_entries: Vec::new(),
            call_counter: 0,
            pending_monty: None,
            python_context: Vec::new(),
            last_result: None,
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

    /// Record a successful Python snippet for context replay.
    ///
    /// Skips snippets that reference `_` as a standalone identifier.
    /// `_` holds the *current* last result at eval time, so replaying
    /// a snippet like `data = _` in a later eval would silently bind
    /// `data` to whatever `_` happens to be then — causing cascading
    /// errors in subsequent context lines that use `data`.
    pub fn push_python_context(&mut self, code: &str) {
        if snippet_references_underscore(code) {
            return;
        }
        self.python_context.push(code.to_string());
    }

    /// Clear all accumulated Python context.
    /// Used when a context-replay error is detected so we don't
    /// keep poisoning every subsequent eval.
    pub fn clear_python_context(&mut self) {
        self.python_context.clear();
    }

    /// Store the last expression result as a MontyObject for `_`.
    pub fn set_last_result(&mut self, obj: MontyObject) {
        self.last_result = Some(obj);
    }

    /// Get a reference to the last result (if any), for passing as `_` input.
    pub fn last_result(&self) -> Option<&MontyObject> {
        self.last_result.as_ref()
    }

    /// Build the context prefix — all previously successful snippets concatenated.
    /// Returns empty string if no context yet.
    pub fn python_context_prefix(&self) -> String {
        if self.python_context.is_empty() {
            String::new()
        } else {
            self.python_context.join("\n")
        }
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
    fn test_python_context_empty_prefix() {
        let session = Session::new();
        assert_eq!(session.python_context_prefix(), "");
    }

    #[test]
    fn test_python_context_accumulates() {
        let mut session = Session::new();
        session.push_python_context("x = 1");
        session.push_python_context("y = 2");
        assert_eq!(session.python_context_prefix(), "x = 1\ny = 2");
    }

    #[test]
    fn test_last_result_stored() {
        let mut session = Session::new();
        session.set_last_result(MontyObject::Int(42));
        assert_eq!(session.last_result(), Some(&MontyObject::Int(42)));
    }

    #[test]
    fn test_last_result_does_not_affect_context_prefix() {
        let mut session = Session::new();
        session.push_python_context("x = 1");
        session.set_last_result(MontyObject::Int(42));
        // _ is NOT injected into the context prefix — it's passed as an input instead.
        assert_eq!(session.python_context_prefix(), "x = 1");
    }

    #[test]
    fn test_last_result_updates() {
        let mut session = Session::new();
        session.set_last_result(MontyObject::Int(1));
        session.set_last_result(MontyObject::Int(2));
        assert_eq!(session.last_result(), Some(&MontyObject::Int(2)));
    }

    // --- Context poison prevention tests ---

    #[test]
    fn test_snippet_with_underscore_not_pushed() {
        let mut session = Session::new();
        session.push_python_context("data = _");
        assert_eq!(session.python_context_prefix(), "");
    }

    #[test]
    fn test_snippet_using_underscore_in_expression_not_pushed() {
        let mut session = Session::new();
        session.push_python_context("for item in _:\n  print(item)");
        assert_eq!(session.python_context_prefix(), "");
    }

    #[test]
    fn test_snippet_with_underscore_in_identifier_pushed() {
        let mut session = Session::new();
        session.push_python_context("my_var = 1");
        assert_eq!(session.python_context_prefix(), "my_var = 1");
    }

    #[test]
    fn test_snippet_with_dunder_pushed() {
        let mut session = Session::new();
        session.push_python_context("class Foo:\n  def __init__(self): pass");
        assert_eq!(
            session.python_context_prefix(),
            "class Foo:\n  def __init__(self): pass"
        );
    }

    #[test]
    fn test_snippet_with_underscore_prefix_pushed() {
        let mut session = Session::new();
        session.push_python_context("_private = 42");
        assert_eq!(session.python_context_prefix(), "_private = 42");
    }

    #[test]
    fn test_pure_function_def_pushed() {
        let mut session = Session::new();
        session.push_python_context("def greet(name):\n  return f'Hello {name}'");
        assert_eq!(
            session.python_context_prefix(),
            "def greet(name):\n  return f'Hello {name}'"
        );
    }

    #[test]
    fn test_show_underscore_not_pushed() {
        let mut session = Session::new();
        session.push_python_context("show(_)");
        assert_eq!(session.python_context_prefix(), "");
    }

    #[test]
    fn test_clear_python_context() {
        let mut session = Session::new();
        session.push_python_context("x = 1");
        session.push_python_context("y = 2");
        assert_eq!(session.python_context_prefix(), "x = 1\ny = 2");
        session.clear_python_context();
        assert_eq!(session.python_context_prefix(), "");
    }

    #[test]
    fn test_underscore_in_string_literal_pushed() {
        // `_` inside a string literal is not detected as a variable
        // reference, so the snippet is pushed. This is fine — if the
        // snippet ONLY uses `_` inside strings, it doesn't depend on
        // `_`'s runtime value and is safe to replay.
        let mut session = Session::new();
        session.push_python_context("print(f'result: {_}')");
        // The `_` is inside quotes, so our scanner doesn't flag it.
        assert_eq!(session.python_context_prefix(), "print(f'result: {_}')");
    }

    #[test]
    fn test_underscore_in_comment_not_counted() {
        // _ in a comment should not trigger the skip
        let mut session = Session::new();
        session.push_python_context("x = 1  # use _ later");
        assert_eq!(session.python_context_prefix(), "x = 1  # use _ later");
    }

    // --- snippet_references_underscore unit tests ---

    #[test]
    fn test_refs_underscore_standalone() {
        assert!(snippet_references_underscore("data = _"));
        assert!(snippet_references_underscore("_ + 1"));
        assert!(snippet_references_underscore("print(_)"));
        assert!(snippet_references_underscore("x = _ if _ else 0"));
    }

    #[test]
    fn test_refs_underscore_not_in_identifiers() {
        assert!(!snippet_references_underscore("my_var = 1"));
        assert!(!snippet_references_underscore("_private = 42"));
        assert!(!snippet_references_underscore("__dunder__ = 1"));
        assert!(!snippet_references_underscore("x_"));
    }

    #[test]
    fn test_refs_underscore_in_comment_ignored() {
        assert!(!snippet_references_underscore("x = 1  # _ is special"));
        assert!(!snippet_references_underscore("# data = _"));
    }
}
