// Pure helpers behind jevgate's UI: log parsing, tallies, row text, stats. No
// `$` here, so they are unit-testable and importable from the function-hook
// module and the /jevgate command.
import { topScores } from './bash-policy.ts';

export type LogEntry = {
  ts: string;
  feature: 'bash' | 'done' | 'agent' | 'compact';
  action: string;
  session?: string;
  tool_use_id?: string;
  reason?: string;
  category?: string;
  command?: string;
  scores?: Record<string, number>;
  ms?: number;
  blocks?: number;
};

export type CompactionRow = {
  tool: string;
  input: string;
  chars: number;
  kept: number;
  score?: number;
  restored: boolean;
};

export type CompactionReport = {
  at: string;
  trigger: string;
  rows: CompactionRow[];
  ratio: number;
  ms: number;
  messages: number;
};

export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line) as LogEntry);
    } catch {
      // a partial first line after slicing
    }
  }
  return out;
}

/** Bash outcomes. `free` is silent and not counted in the footer. `ok` covers allow and silent alike; pre-0.2 names fold in. */
export const BASH_FREE = new Set(['free', 'not-asked', 'passthrough']);
export const BASH_OK = new Set(['ok', 'allow', 'fast-lane', 'unsure', 'pass']);
export const BASH_DENIED = new Set(['denied', 'unreachable']);

export type Tally = { free: number; ok: number; denied: number; blocks: number; agentDenies: number };

export function tally(entries: readonly LogEntry[], session: string): Tally {
  const t: Tally = { free: 0, ok: 0, denied: 0, blocks: 0, agentDenies: 0 };
  for (const e of entries) {
    if (e.session !== session) continue;
    if (e.feature === 'bash') {
      if (BASH_FREE.has(e.action)) t.free++;
      else if (BASH_OK.has(e.action)) t.ok++;
      else if (BASH_DENIED.has(e.action)) t.denied++;
    } else if (e.feature === 'done' && e.action === 'block') t.blocks++;
    else if (e.feature === 'agent' && e.action === 'deny') t.agentDenies++;
  }
  return t;
}

/** Short form for the prompt footer's mode labels: `jev ✓5 ⊘1 ✗1 ⇢1 ⇊1`. */
export function footerLabel(t: Tally, compactions: number): string | undefined {
  const parts: string[] = [];
  if (t.ok) parts.push(`✓${t.ok}`);
  if (t.denied) parts.push(`⊘${t.denied}`);
  if (t.blocks) parts.push(`✗${t.blocks}`);
  if (t.agentDenies) parts.push(`⇢${t.agentDenies}`);
  if (compactions) parts.push(`⇊${compactions}`);
  return parts.length ? `jev ${parts.join(' ')}` : undefined;
}

export function statusText(t: Tally, compactions: number): string | undefined {
  const parts: string[] = [];
  if (t.ok) parts.push(`✓${t.ok} ok`);
  if (t.denied) parts.push(`⊘${t.denied} denied`);
  if (t.blocks) parts.push(`✗${t.blocks} done-check`);
  if (t.agentDenies) parts.push(`⇢${t.agentDenies} subagent`);
  if (compactions) parts.push(`⇊${compactions} compact`);
  return parts.length ? `jev ${parts.join(' · ')}` : undefined;
}

/** The dim line under a Bash row; undefined keeps the row as the engine drew it (free commands stay silent). */
export function bashRowText(e: LogEntry): string | undefined {
  if (e.feature !== 'bash') return undefined;
  if (e.action === 'ok' || e.action === 'allow') return `▸ jevgate ${e.action} · ${e.scores ? topScores(e.scores) : ''} · ${e.ms ?? '?'}ms`;
  if (e.action === 'denied') {
    const score = e.category && e.scores ? ` ${(e.scores[e.category] ?? 0).toFixed(2)}` : '';
    return `✗ jevgate denied · ${e.category ?? e.reason ?? ''}${score}`;
  }
  if (e.action === 'unreachable') return `✗ jevgate unreachable · Jev did not answer · ${e.ms ?? '?'}ms`;
  return undefined;
}

export function kb(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export type BashStats = {
  free: number;
  /** Judged and ran, allow and silent together. */
  ok: number;
  /** Of `ok`, those the hook answered allow (classifier skipped in auto mode). */
  allowed: number;
  denied: number;
  unreachable: number;
  /** Denied entries per category, most frequent first. */
  categories: [string, number][];
  /** Mean Jev latency over judged commands. */
  avgMs: number;
  blocks: number;
  agentDenies: number;
};

export function bashStats(entries: readonly LogEntry[], session?: string): BashStats {
  const s: BashStats = { free: 0, ok: 0, allowed: 0, denied: 0, unreachable: 0, categories: [], avgMs: 0, blocks: 0, agentDenies: 0 };
  const cats = new Map<string, number>();
  let msSum = 0;
  let msN = 0;
  for (const e of entries) {
    if (session !== undefined && e.session !== session) continue;
    if (e.feature === 'done' && e.action === 'block') s.blocks++;
    if (e.feature === 'agent' && e.action === 'deny') s.agentDenies++;
    if (e.feature !== 'bash') continue;
    if (BASH_FREE.has(e.action)) s.free++;
    else if (BASH_OK.has(e.action)) {
      s.ok++;
      if (e.action === 'allow') s.allowed++;
    } else if (e.action === 'denied') {
      s.denied++;
      const c = e.category ?? e.reason ?? '?';
      cats.set(c, (cats.get(c) ?? 0) + 1);
    } else if (e.action === 'unreachable') s.unreachable++;
    if (typeof e.ms === 'number' && (BASH_OK.has(e.action) || e.action === 'denied')) {
      msSum += e.ms;
      msN++;
    }
  }
  s.categories = [...cats].sort((a, b) => b[1] - a[1]);
  s.avgMs = msN ? Math.round(msSum / msN) : 0;
  return s;
}

/** Session id of the newest entry that has one. */
export function latestSession(entries: readonly LogEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.session) return entries[i]!.session;
  return undefined;
}

export function formatStats(session: BashStats, all: BashStats, sessionId?: string): string {
  const judged = (s: BashStats) => s.ok + s.denied + s.unreachable;
  const row = (label: string, s: BashStats) => {
    const total = s.free + judged(s);
    const pct = (n: number) => (total ? `${Math.round((100 * n) / total)}%` : '-');
    return `${label.padEnd(9)} free ${String(s.free).padStart(5)} (${pct(s.free).padStart(4)})  ok ${String(s.ok).padStart(5)} (allow ${s.allowed})  denied ${String(s.denied).padStart(4)}  unreachable ${String(s.unreachable).padStart(3)}  avg ${s.avgMs}ms  done-check ✗${s.blocks}  subagent ⇢${s.agentDenies}`;
  };
  const lines = ['jevgate bash guard', row(`session${sessionId ? '' : '*'}`, session), row('all-time', all)];
  if (all.categories.length) {
    lines.push('denied by category (all-time): ' + all.categories.map(([c, n]) => `${c} ${n}`).join(', '));
  }
  if (!sessionId) lines.push('* no session id in the log; session row is empty');
  return lines.join('\n');
}
