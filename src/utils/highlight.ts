/**
 * Syntax highlighting utility using highlight.js.
 *
 * Provides a thin wrapper around highlight.js with only the Python
 * language loaded (keeps the bundle small). Returns pre-tokenized HTML
 * strings suitable for use with Lit's unsafeHTML directive.
 *
 * Also exports a CSS template literal for use inside shadow DOM components.
 */

import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';

// Register only Python — keeps the bundle small.
hljs.registerLanguage('python', python);

/**
 * Syntax-highlight a Python code string.
 * Returns an HTML string with <span class="hljs-..."> tokens.
 */
export function highlightPython(code: string): string {
  return hljs.highlight(code, { language: 'python' }).value;
}

/**
 * Tokyo Night–inspired highlight.js theme as a CSS string.
 * Designed to match Signal Deck's colour palette.
 */
export const highlightStyles = `
  /* ── highlight.js — Tokyo Night theme ── */
  .hljs {
    color: #a9b1d6;
    background: transparent;
  }

  .hljs-keyword,
  .hljs-built_in {
    color: #bb9af7;
  }

  .hljs-string,
  .hljs-doctag {
    color: #9ece6a;
  }

  .hljs-number,
  .hljs-literal {
    color: #ff9e64;
  }

  .hljs-title.function_,
  .hljs-title.class_ {
    color: #7aa2f7;
  }

  .hljs-params {
    color: #e0af68;
  }

  .hljs-comment {
    color: #565f89;
    font-style: italic;
  }

  .hljs-operator,
  .hljs-punctuation {
    color: #89ddff;
  }

  .hljs-variable,
  .hljs-attr {
    color: #c0caf5;
  }

  .hljs-meta {
    color: #ff9e64;
  }

  .hljs-type {
    color: #2ac3de;
  }

  .hljs-selector-tag {
    color: #bb9af7;
  }

  .hljs-subst {
    color: #a9b1d6;
  }
`;
