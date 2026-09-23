// Pure helpers behind jevgate's UI: log parsing, tallies, row text, stats. No
// `$` here, so they are unit-testable and importable from the function-hook
// module and the /jevgate command.
import { topScores } from './bash-policy.ts';

export type LogEntry = {
  ts: string;
  feature: 'bash' | 'file' | 'done' | 'agent' | 'compact';
  action: string;
  tool?: string;
  path?: string;
  session?: string;
  tool_use_id?: string;
  reason?: string;
  category?: string;
  command?: string;
  scores?: Record<string, number>;
  facts?: Record<string, string>;
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

/** Bash outcomes. `free` is silent and not counted in the footer. `ok` covers allow and (before 0.4) silent; older names fold in. */
export const BASH_FREE = new Set(['free', 'not-asked', 'passthrough']);
export const BASH_OK = new Set(['ok', 'allow', 'fast-lane', 'unsure', 'pass']);
export const BASH_ASKED = new Set(['asked']);
/** Written by the UI module once an asked call settled: the user's answer at the prompt. */
export const ASK_ANSWERS = { 'ask-approved': 'you approved', 'ask-rejected': 'you rejected' } as const;

/**
 * Your answer to an asked call, read off how the call settled: a rejection
 * comes back as an error with Claude Code's rejection text; a call that ran
 * (even one that then failed) was approved. Refused with jevgate's own reason
 * means nobody was asked (headless, dontAsk): no answer.
 */
export function askAnswer(result: unknown): keyof typeof ASK_ANSWERS | undefined {
  const r = (result ?? {}) as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown };
  const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : typeof r.deny === 'string' ? r.deny : '';
  if (/^(Error: )?jevgate:/.test(text)) return undefined;
  if ((r.isError || r.deny) && /doesn't want to proceed with this tool use|User rejected tool use/i.test(text)) return 'ask-rejected';
  return 'ask-approved';
}

/** The flags of a guard entry, one per fact: `deletes local_no_copy, not requested` is two. Older single names pass through. */
export function flagsOf(e: LogEntry): string[] {
  const c = e.category ?? e.reason ?? '?';
  return (e.facts ? c.split(', ') : [c]).map((f) => (e.feature === 'file' ? 'file:' : '') + f);
}
export const BASH_DENIED = new Set(['denied', 'unreachable']);

export type Tally = { free: number; ok: number; asked: number; denied: number; blocks: number; agentDenies: number };

export function tally(entries: readonly LogEntry[], session: string): Tally {
  const t: Tally = { free: 0, ok: 0, asked: 0, denied: 0, blocks: 0, agentDenies: 0 };
  for (const e of entries) {
    if (e.session !== session) continue;
    if (e.feature === 'bash' || e.feature === 'file') {
      if (BASH_FREE.has(e.action)) t.free++;
      else if (BASH_OK.has(e.action)) t.ok++;
      else if (BASH_ASKED.has(e.action)) t.asked++;
      else if (BASH_DENIED.has(e.action)) t.denied++;
    } else if (e.feature === 'done' && e.action === 'block') t.blocks++;
    else if (e.feature === 'agent' && e.action === 'deny') t.agentDenies++;
  }
  return t;
}

/** Short form for the prompt footer's mode labels: `jev ✓5 ?2 ⊘1 ✗1 ⇢1 ⇊1`. */
export function footerLabel(t: Tally, compactions: number): string | undefined {
  const parts: string[] = [];
  if (t.ok) parts.push(`✓${t.ok}`);
  if (t.asked) parts.push(`?${t.asked}`);
  if (t.denied) parts.push(`⊘${t.denied}`);
  if (t.blocks) parts.push(`✗${t.blocks}`);
  if (t.agentDenies) parts.push(`⇢${t.agentDenies}`);
  if (compactions) parts.push(`⇊${compactions}`);
  return parts.length ? `jev ${parts.join(' ')}` : undefined;
}

export function statusText(t: Tally, compactions: number): string | undefined {
  const parts: string[] = [];
  if (t.ok) parts.push(`✓${t.ok} ok`);
  if (t.asked) parts.push(`?${t.asked} asked`);
  if (t.denied) parts.push(`⊘${t.denied} denied`);
  if (t.blocks) parts.push(`✗${t.blocks} done-check`);
  if (t.agentDenies) parts.push(`⇢${t.agentDenies} subagent`);
  if (compactions) parts.push(`⇊${compactions} compact`);
  return parts.length ? `jev ${parts.join(' · ')}` : undefined;
}

/** What a guard entry says about its flags: the new `category` list, or the old top scores. */
function detail(e: LogEntry): string {
  if (e.facts) return e.category || 'nothing flagged';
  if (e.category && e.scores) return `${e.category} ${(e.scores[e.category] ?? 0).toFixed(2)}`;
  return e.category ?? e.reason ?? '';
}

/** The dim line under a Bash or file-tool row; undefined keeps the row as the engine drew it (free calls stay silent). */
export function bashRowText(e: LogEntry): string | undefined {
  if (e.feature !== 'bash' && e.feature !== 'file') return undefined;
  const ms = `${e.ms ?? '?'}ms`;
  if (e.action === 'denied') return `✗ jevgate denied · ${detail(e)}`;
  if (e.action === 'asked') return `? jevgate asked · ${e.category === 'blocked' ? 'Jev could not judge (gateway block)' : detail(e)} · ${ms}`;
  if (e.action === 'unreachable') return `✗ jevgate unreachable · Jev did not answer · ${ms}`;
  if (e.action === 'allow') return `▸ jevgate allow · ${e.facts ? 'nothing flagged' : e.scores ? topScores(e.scores) : ''} · ${ms}`;
  if (e.action === 'ok') return `▸ jevgate unsure · ${e.feature === 'file' ? 'outside project · ' : ''}${e.scores ? topScores(e.scores) : ''} · ${ms}`;
  return undefined;
}

/** The dim line under a collapsed group: every ask, denial or failure in it, then how many ran allowed. */
export function groupSummary(lines: readonly (string | undefined)[]): string[] {
  const out = lines.filter((l): l is string => !!l && !l.startsWith('▸'));
  const allowed = lines.filter((l) => l?.startsWith('▸ jevgate allow')).length;
  if (allowed) out.push(`▸ jevgate allow ×${allowed}`);
  return out;
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
  /** Asked the user (a real prompt, in bypass mode too). */
  asked: number;
  /** Of `asked`, your answer at the prompt; the rest are pending or predate the record. */
  approved: number;
  rejected: number;
  /** Of `asked`, those the gateway in front of Jev blocked, not a fact. */
  blocked: number;
  /** Asked entries per flag, most frequent first. */
  askedBy: [string, number][];
  denied: number;
  unreachable: number;
  /** Denied entries per category, most frequent first. */
  categories: [string, number][];
  /** Mean Jev latency over judged commands. */
  avgMs: number;
  /** Latencies of the newest judged commands, oldest first, at most 40. */
  msRecent: number[];
  blocks: number;
  agentDenies: number;
};

export function bashStats(entries: readonly LogEntry[], session?: string): BashStats {
  const s: BashStats = { free: 0, ok: 0, allowed: 0, asked: 0, approved: 0, rejected: 0, blocked: 0, askedBy: [], denied: 0, unreachable: 0, categories: [], avgMs: 0, msRecent: [], blocks: 0, agentDenies: 0 };
  const cats = new Map<string, number>();
  const asks = new Map<string, number>();
  const bump = (m: Map<string, number>, e: LogEntry) => { for (const f of flagsOf(e)) m.set(f, (m.get(f) ?? 0) + 1); };
  let msSum = 0;
  let msN = 0;
  for (const e of entries) {
    if (session !== undefined && e.session !== session) continue;
    if (e.feature === 'done' && e.action === 'block') s.blocks++;
    if (e.feature === 'agent' && e.action === 'deny') s.agentDenies++;
    if (e.feature !== 'bash' && e.feature !== 'file') continue;
    if (e.feature === 'file' && e.action === 'free') continue; // in-project writes are not interesting
    if (e.action === 'ask-approved') { s.approved++; continue; }
    if (e.action === 'ask-rejected') { s.rejected++; continue; }
    if (BASH_FREE.has(e.action)) s.free++;
    else if (BASH_OK.has(e.action)) {
      s.ok++;
      if (e.action === 'allow') s.allowed++;
    } else if (BASH_ASKED.has(e.action)) {
      s.asked++;
      if (e.category === 'blocked') s.blocked++;
      else bump(asks, e);
    } else if (e.action === 'denied') {
      s.denied++;
      bump(cats, e);
    } else if (e.action === 'unreachable') s.unreachable++;
    if (typeof e.ms === 'number' && (BASH_OK.has(e.action) || BASH_ASKED.has(e.action) || e.action === 'denied')) {
      msSum += e.ms;
      msN++;
      s.msRecent.push(e.ms);
      if (s.msRecent.length > 40) s.msRecent.shift();
    }
  }
  s.categories = [...cats].sort((a, b) => b[1] - a[1]);
  s.askedBy = [...asks].sort((a, b) => b[1] - a[1]);
  s.avgMs = msN ? Math.round(msSum / msN) : 0;
  return s;
}

/** Session id of the newest entry that has one. */
export function latestSession(entries: readonly LogEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.session) return entries[i]!.session;
  return undefined;
}

export function formatStats(session: BashStats, all: BashStats, sessionId?: string): string {
  const judged = (s: BashStats) => s.ok + s.asked + s.denied + s.unreachable;
  const row = (label: string, s: BashStats) => {
    const total = s.free + judged(s);
    const pct = (n: number) => (total ? `${Math.round((100 * n) / total)}%` : '-');
    return `${label.padEnd(9)} free ${String(s.free).padStart(5)} (${pct(s.free).padStart(4)})  ok ${String(s.ok).padStart(5)} (allow ${s.allowed})  asked ${String(s.asked).padStart(4)} (✓${s.approved} ✗${s.rejected})  denied ${String(s.denied).padStart(4)}  unreachable ${String(s.unreachable).padStart(3)}  avg ${s.avgMs}ms  done-check ✗${s.blocks}  subagent ⇢${s.agentDenies}`;
  };
  const lines = ['jevgate guard (bash + file tools)', row(`session${sessionId ? '' : '*'}`, session), row('all-time', all)];
  if (all.categories.length) {
    lines.push('denied by flag (all-time): ' + all.categories.map(([c, n]) => `${c} ${n}`).join(', '));
  }
  if (all.askedBy.length) {
    lines.push('asked by flag (all-time): ' + all.askedBy.map(([c, n]) => `${c} ${n}`).join(', '));
  }
  if (!sessionId) lines.push('* no session id in the log; session row is empty');
  return lines.join('\n');
}
