// Pure helpers behind jevgate's UI: log parsing, tallies, row text, stats. No
// `$` here, so they are unit-testable and importable from the function-hook
// module and the /jevgate command.

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
  /** Jev call timing. `connectMs` is 0.4's (a connection per call); 0.5 keeps one open, and `cold` marks the call that opened it. */
  startMs?: number;
  prepMs?: number;
  connectMs?: number;
  serverMs?: number;
  cold?: boolean;
  tries?: number;
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

/** The flags of a guard entry, one per fact: `deletes local_no_copy, not requested` is two. */
export function flagsOf(e: LogEntry): string[] {
  const c = e.category ?? e.reason ?? '?';
  return c.split(', ').filter(Boolean).map((f) => (e.feature === 'file' ? 'file:' : '') + f);
}
/** A flag as shown, `max` chars at most: a file-tool flag keeps its ` [F]` mark when cut. */
export function flagLabel(flag: string, max = Infinity): string {
  if (!flag.startsWith('file:')) return flag.slice(0, max);
  return flag.slice(5, 5 + Math.max(0, max - 4)) + ' [F]';
}

/** Guard outcomes per session. `free` is silent and not counted in the footer; unreachable counts as denied there. */
export type Tally = { free: number; allowed: number; asked: number; denied: number; blocks: number; agentDenies: number; compactions: number };

export function tally(entries: readonly LogEntry[], session: string): Tally {
  const t: Tally = { free: 0, allowed: 0, asked: 0, denied: 0, blocks: 0, agentDenies: 0, compactions: 0 };
  for (const e of entries) {
    if (e.session !== session) continue;
    if (e.feature === 'bash' || e.feature === 'file') {
      if (e.action === 'free') t.free++;
      else if (e.action === 'allow') t.allowed++;
      else if (e.action === 'asked') t.asked++;
      else if (e.action === 'denied' || e.action === 'unreachable') t.denied++;
    } else if (e.feature === 'done' && e.action === 'block') t.blocks++;
    else if (e.feature === 'agent' && e.action === 'deny') t.agentDenies++;
    else if (e.feature === 'compact' && e.action === 'verbatim') t.compactions++;
  }
  return t;
}

/** Short form for the prompt footer's mode labels: `jev ✓5 ?2 ⊘1 ✗1 ⇢1 ⇊1`. */
export function footerLabel(t: Tally): string | undefined {
  const parts: string[] = [];
  if (t.allowed) parts.push(`✓${t.allowed}`);
  if (t.asked) parts.push(`?${t.asked}`);
  if (t.denied) parts.push(`⊘${t.denied}`);
  if (t.blocks) parts.push(`✗${t.blocks}`);
  if (t.agentDenies) parts.push(`⇢${t.agentDenies}`);
  if (t.compactions) parts.push(`⇊${t.compactions}`);
  return parts.length ? `jev ${parts.join(' ')}` : undefined;
}

export function statusText(t: Tally): string | undefined {
  const parts: string[] = [];
  if (t.allowed) parts.push(`✓${t.allowed} allowed`);
  if (t.asked) parts.push(`?${t.asked} asked`);
  if (t.denied) parts.push(`⊘${t.denied} denied`);
  if (t.blocks) parts.push(`✗${t.blocks} done-check`);
  if (t.agentDenies) parts.push(`⇢${t.agentDenies} subagent`);
  if (t.compactions) parts.push(`⇊${t.compactions} compact`);
  return parts.length ? `jev ${parts.join(' · ')}` : undefined;
}


/** The dim line under a Bash or file-tool row; undefined keeps the row as the engine drew it (free calls stay silent). */
export function bashRowText(e: LogEntry): string | undefined {
  if (e.feature !== 'bash' && e.feature !== 'file') return undefined;
  const ms = `${e.ms ?? '?'}ms`;
  const flags = e.category || e.reason || '';
  if (e.action === 'denied') return `✗ jevgate denied · ${flags}`;
  if (e.action === 'asked') return `? jevgate asked · ${e.category === 'blocked' ? 'Jev could not judge (gateway block)' : flags} · ${ms}`;
  if (e.action === 'unreachable') return `✗ jevgate unreachable · ${e.category === 'blocked' ? 'gateway blocked the request' : 'Jev did not answer'} · ${ms}`;
  if (e.action === 'allow') return `▸ jevgate allow · nothing flagged · ${ms}`;
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

/** One Jev call split by where its time went; `server` is missing when Jev did not answer. */
export type Timing = { ms: number; prep: number; connect: number; server?: number; answered: boolean; tries: number; cold?: boolean };

export function timingOf(e: LogEntry): Timing | undefined {
  if (typeof e.ms !== 'number' || typeof e.prepMs !== 'number') return undefined;
  const answered = e.action !== 'unreachable' && e.action !== 'error';
  return { ms: e.ms, prep: e.prepMs, connect: e.connectMs ?? 0, server: answered ? e.serverMs : undefined, answered, tries: e.tries ?? 1, ...(e.cold ? { cold: true } : {}) };
}

export type BashStats = {
  free: number;
  /** Judged and allowed (in auto mode the classifier is skipped). */
  allowed: number;
  /** Asked the user (a real prompt, in bypass mode too). */
  asked: number;
  /** Of `asked`, your answer at the prompt; the rest were not answered (headless, dontAsk) or are pending. */
  approved: number;
  rejected: number;
  /** Of `asked`, those the gateway in front of Jev blocked, not a fact. */
  blocked: number;
  /** Asked entries per flag, most frequent first. */
  askedBy: [string, number][];
  denied: number;
  unreachable: number;
  /** Denied entries per flag, most frequent first. */
  categories: [string, number][];
  /** Mean Jev latency over judged commands. */
  avgMs: number;
  /** Latencies of the newest judged commands, oldest first, at most 200. */
  msRecent: number[];
  /** Parallel to `msRecent`: the call's timing, or undefined for calls logged before timings were. */
  timingRecent: (Timing | undefined)[];
  /** The newest Jev call of any hook, answered or not. */
  lastCall?: Timing;
  blocks: number;
  agentDenies: number;
};

export function bashStats(entries: readonly LogEntry[], session?: string): BashStats {
  const s: BashStats = { free: 0, allowed: 0, asked: 0, approved: 0, rejected: 0, blocked: 0, askedBy: [], denied: 0, unreachable: 0, categories: [], avgMs: 0, msRecent: [], timingRecent: [], blocks: 0, agentDenies: 0 };
  const cats = new Map<string, number>();
  const asks = new Map<string, number>();
  const bump = (m: Map<string, number>, e: LogEntry) => { for (const f of flagsOf(e)) m.set(f, (m.get(f) ?? 0) + 1); };
  let msSum = 0;
  let msN = 0;
  for (const e of entries) {
    if (session !== undefined && e.session !== session) continue;
    const timing = timingOf(e);
    if (timing) s.lastCall = timing;
    if (e.feature === 'done' && e.action === 'block') s.blocks++;
    if (e.feature === 'agent' && e.action === 'deny') s.agentDenies++;
    if (e.feature !== 'bash' && e.feature !== 'file') continue;
    if (e.feature === 'file' && e.action === 'free') continue; // in-project writes are not interesting
    if (e.action === 'ask-approved') { s.approved++; continue; }
    if (e.action === 'ask-rejected') { s.rejected++; continue; }
    if (e.action === 'free') s.free++;
    else if (e.action === 'allow') s.allowed++;
    else if (e.action === 'asked') {
      s.asked++;
      if (e.category === 'blocked') s.blocked++;
      else bump(asks, e);
    } else if (e.action === 'denied') {
      s.denied++;
      bump(cats, e);
    } else if (e.action === 'unreachable') s.unreachable++;
    if (typeof e.ms === 'number' && (e.action === 'allow' || e.action === 'asked' || e.action === 'denied')) {
      msSum += e.ms;
      msN++;
      s.msRecent.push(e.ms);
      s.timingRecent.push(timing);
      if (s.msRecent.length > 200) { s.msRecent.shift(); s.timingRecent.shift(); }
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
  const judged = (s: BashStats) => s.allowed + s.asked + s.denied + s.unreachable;
  const row = (label: string, s: BashStats) => {
    const total = s.free + judged(s);
    const pct = (n: number) => (total ? `${Math.round((100 * n) / total)}%` : '-');
    return `${label.padEnd(9)} free ${String(s.free).padStart(5)} (${pct(s.free).padStart(4)})  allow ${String(s.allowed).padStart(5)}  asked ${String(s.asked).padStart(4)} (✓${s.approved} ✗${s.rejected})  denied ${String(s.denied).padStart(4)}  unreachable ${String(s.unreachable).padStart(3)}  avg ${s.avgMs}ms  done-check ✗${s.blocks}  subagent ⇢${s.agentDenies}`;
  };
  const lines = ['jevgate guard (bash + file tools)', row(`session${sessionId ? '' : '*'}`, session), row('all-time', all)];
  if (all.categories.length) {
    lines.push('denied by flag (all-time): ' + all.categories.map(([c, n]) => `${flagLabel(c)} ${n}`).join(', '));
  }
  if (all.askedBy.length) {
    lines.push('asked by flag (all-time): ' + all.askedBy.map(([c, n]) => `${flagLabel(c)} ${n}`).join(', '));
  }
  if (!sessionId) lines.push('* no session id in the log; session row is empty');
  return lines.join('\n');
}
