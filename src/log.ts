// Log lines. The module appends them with a real append (`sh -c 'cat >> …'`
// through `$.process.run`), since several sessions write the same files and
// `$.fs` can only rewrite a whole file.

export type Decision = {
  feature: 'bash' | 'file' | 'done' | 'agent' | 'compact';
  action: string;
  session?: string;
  [k: string]: unknown;
};

/** What the footer, row lines and /jevgate read: no commands, paths or prompts. */
export const STATS_FIELDS = ['ts', 'feature', 'action', 'session', 'tool_use_id', 'category', 'reason', 'ms', 'startMs', 'prepMs', 'connectMs', 'serverMs', 'tries'] as const;

export function statsEntry(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of STATS_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

export function formatEntry(d: Record<string, unknown>, now = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), ...d }) + '\n';
}

/** The stats line always; the full line only with the `log` option on. */
export function logLines(d: Decision, full: boolean, now = new Date()): { stats: string; full?: string } {
  return { stats: formatEntry(statsEntry(d), now), ...(full ? { full: formatEntry(d, now) } : {}) };
}
