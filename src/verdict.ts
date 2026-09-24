// The hand-off between the module and hooks/answer.sh. The module judges a call
// in its tool.call hook, before Claude Code's permission step, and leaves the
// verdict at verdicts/<tool_use_id>; answer.sh, a PreToolUse command hook,
// answers Claude Code with it, so an ask is Claude Code's own prompt.

/**
 * `free`: nothing to judge. `unreachable`, `blocked`, `nokey`: no verdict, which
 * answer.sh settles by the permission mode it is given (the module is not).
 */
export type VerdictKind = 'allow' | 'ask' | 'deny' | 'free' | 'unreachable' | 'blocked' | 'nokey';

/** One outcome: for the permission mode `mode`, or `*` for every mode without its own line. */
export type VerdictLine = { mode: string; kind: VerdictKind; reason: string };

/** A line per outcome, `<mode>\t<kind>\t<reason as a JSON string>`, so answer.sh prints the reason as is. */
export function verdictText(lines: readonly VerdictLine[]): string {
  return lines.map((l) => `${l.mode}\t${l.kind}\t${JSON.stringify(l.reason)}\n`).join('');
}

/**
 * The part of the hook's stdin JSON that must be there for the verdict to apply:
 * the judged command or path, spelled as JSON spells it. A call changed after it
 * was judged (another hook rewrote it) does not match.
 */
export function matchFragment(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Bash') return typeof input.command === 'string' ? `"command":${JSON.stringify(input.command)}` : undefined;
  for (const key of ['file_path', 'notebook_path']) {
    if (typeof input[key] === 'string') return `"${key}":${JSON.stringify(input[key])}`;
  }
  return undefined;
}

/** A tool_use_id safe to use as a file name. */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
