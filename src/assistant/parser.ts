/**
 * Markdown parser for the Signal Analyst agent loop.
 *
 * Follows the markdown_agent pattern:
 * - Extract ```signal-deck fenced code blocks
 * - Strip hallucinated ```result blocks (LLM must not write these)
 * - Inject real execution results after code blocks
 *
 * The convention:
 * - LLM writes ```signal-deck blocks for code it wants executed
 * - After execution, a ```result block is appended right after
 * - On subsequent turns the LLM sees both its code *and* the output
 */

/** A single fenced code block extracted from a markdown document. */
export interface CodeBlock {
  language: string;
  code: string;
  /** 0-indexed line where the opening fence is. */
  startLine: number;
  /** 0-indexed line where the closing fence is. */
  endLine: number;
  /** True if a ```result block already follows this block. */
  hasResult: boolean;
}

/** A parsed markdown document with extracted code blocks. */
export interface ParsedDocument {
  lines: string[];
  codeBlocks: CodeBlock[];
}

/** Languages we execute in the shell. */
const EXECUTABLE_LANGUAGES = new Set(['signal-deck', 'python']);

/** Language tag for injected results. */
const RESULT_TAG = 'result';

/** Match an opening code fence: ```lang */
const FENCE_OPEN = /^(\s*)```(\w[\w-]*)\s*$/;

/** Match a closing code fence: ``` */
const FENCE_CLOSE = /^(\s*)```\s*$/;

/**
 * Get the text of a parsed document.
 */
export function getText(doc: ParsedDocument): string {
  return doc.lines.join('\n');
}

/**
 * Get executable blocks — those in executable languages without existing results.
 */
export function getExecutableBlocks(doc: ParsedDocument): CodeBlock[] {
  return doc.codeBlocks.filter(
    (b) => EXECUTABLE_LANGUAGES.has(b.language) && !b.hasResult,
  );
}

/**
 * Strip any ```result ... ``` blocks from markdown.
 *
 * This is the key defense against hallucinated results — the LLM might
 * write its own ```result blocks, but we throw them away and only inject
 * real execution output.
 */
export function stripResultBlocks(markdown: string): string {
  const lines = markdown.split('\n');
  const cleaned: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const openMatch = FENCE_OPEN.exec(lines[i]);
    if (openMatch && openMatch[2] === RESULT_TAG) {
      // Skip this entire result block (opening fence → closing fence)
      let j = i + 1;
      while (j < lines.length) {
        if (FENCE_CLOSE.test(lines[j])) {
          break;
        }
        j++;
      }
      // Jump past the closing fence (or end of file if unclosed)
      i = j + 1;
      continue;
    }
    cleaned.push(lines[i]);
    i++;
  }

  return cleaned.join('\n');
}

/**
 * Parse a markdown string into a ParsedDocument with extracted code blocks.
 *
 * If sanitize=true (default), any ```result blocks in the input are stripped
 * first — this removes hallucinated results from LLM output.
 */
export function parse(markdown: string, sanitize = true): ParsedDocument {
  if (sanitize) {
    markdown = stripResultBlocks(markdown);
  }

  const lines = markdown.split('\n');
  const blocks: CodeBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const openMatch = FENCE_OPEN.exec(lines[i]);
    if (openMatch) {
      const lang = openMatch[2];
      const start = i;

      // Scan forward for the closing fence
      let j = i + 1;
      while (j < lines.length) {
        if (FENCE_CLOSE.test(lines[j])) {
          break;
        }
        j++;
      }

      if (j >= lines.length) {
        // No closing fence found — skip this opening fence
        i++;
        continue;
      }

      const end = j;
      const code = lines.slice(start + 1, end).join('\n');

      // Check if a result block immediately follows
      let hasResult = false;
      if (end + 1 < lines.length) {
        const nextMatch = FENCE_OPEN.exec(lines[end + 1]);
        if (nextMatch && nextMatch[2] === RESULT_TAG) {
          hasResult = true;
        }
      }

      blocks.push({
        language: lang,
        code,
        startLine: start,
        endLine: end,
        hasResult,
      });

      i = end + 1;
    } else {
      i++;
    }
  }

  return { lines, codeBlocks: blocks };
}

/**
 * Inject an execution result immediately after a code block.
 *
 * Returns a new ParsedDocument with the result block inserted and
 * all line references updated (via re-parse).
 */
export function injectResult(
  doc: ParsedDocument,
  block: CodeBlock,
  result: string,
): ParsedDocument {
  const resultLines = [
    `\`\`\`${RESULT_TAG}`,
    result.replace(/\n$/, ''),
    '```',
  ];

  // Insert after the closing fence of the code block
  const insertAt = block.endLine + 1;
  const newLines = [
    ...doc.lines.slice(0, insertAt),
    ...resultLines,
    ...doc.lines.slice(insertAt),
  ];

  // Re-parse to get correct line numbers (don't sanitize — these are real results)
  return parse(newLines.join('\n'), false);
}

/**
 * Check if a code block is comment-only (no actual executable code).
 * Helps skip blocks where the LLM is just explaining in fences.
 */
export function isCommentOnly(code: string): boolean {
  for (const line of code.split('\n')) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('#') && !stripped.startsWith('//')) {
      return false;
    }
  }
  return true;
}
