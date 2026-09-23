// The compaction question: its labels and what an answer means. No node: imports (hooks/compact.ts loads this).

export const TRIM = 'jevgate: trim old tool outputs';
export const SUMMARY = 'Claude Code: built-in summary';
export const LATER = 'Not yet';
export const CANCEL = 'Cancel';

export type CompactChoice = 'trim' | 'summary' | 'none';

/** An answer to the question; Esc, free text or the Not yet / Cancel option is `none`. */
export function choiceOf(answer: string | undefined): CompactChoice {
  if (answer === TRIM) return 'trim';
  if (answer === SUMMARY) return 'summary';
  return 'none';
}

/** After Not yet at `percent`, the next reminder: the next 10% step above it. */
export function snoozeTo(percent: number): number {
  return (Math.floor(percent / 10) + 1) * 10;
}
