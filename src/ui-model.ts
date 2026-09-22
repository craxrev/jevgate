// Pure helpers behind jevgate's UI: log parsing, tallies, row text. No `$` here,
// so they are unit-testable and importable from the function-hook module.

export type LogEntry = {
  ts: string;
  feature: 'bash' | 'done' | 'agent' | 'compact';
  action: string;
  session?: string;
  tool_use_id?: string;
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

export type Tally = { allowed: number; passed: number; passthrough: number; blocks: number; agentDenies: number };

export function tally(entries: readonly LogEntry[], session: string): Tally {
  const t: Tally = { allowed: 0, passed: 0, passthrough: 0, blocks: 0, agentDenies: 0 };
  for (const e of entries) {
    if (e.session !== session) continue;
    if (e.feature === 'bash') {
      if (e.action === 'allow') t.allowed++;
      else if (e.action === 'pass') t.passed++;
      else if (e.action === 'passthrough') t.passthrough++;
    } else if (e.feature === 'done' && e.action === 'block') t.blocks++;
    else if (e.feature === 'agent' && e.action === 'deny') t.agentDenies++;
  }
  return t;
}

/** Short form for the prompt footer's mode labels: `jev ✓5 ↷1 ✗1 ⇊1`. */
export function footerLabel(t: Tally, compactions: number): string | undefined {
  const parts: string[] = [];
  if (t.allowed) parts.push(`✓${t.allowed}`);
  if (t.passed) parts.push(`↷${t.passed}`);
  if (t.blocks) parts.push(`✗${t.blocks}`);
  if (t.agentDenies) parts.push(`⊘${t.agentDenies}`);
  if (compactions) parts.push(`⇊${compactions}`);
  return parts.length ? `jev ${parts.join(' ')}` : undefined;
}

export function statusText(t: Tally, compactions: number): string | undefined {
  const parts: string[] = [];
  if (t.allowed) parts.push(`✓${t.allowed} fast-lane`);
  if (t.passed) parts.push(`↷${t.passed} classifier`);
  if (t.blocks) parts.push(`✗${t.blocks} done-check`);
  if (t.agentDenies) parts.push(`⊘${t.agentDenies} subagent`);
  if (compactions) parts.push(`⇊${compactions} compact`);
  return parts.length ? `jev ${parts.join(' · ')}` : undefined;
}

function fmtScores(s: Record<string, number> | undefined): string {
  if (!s) return '';
  return Object.entries(s)
    .map(([k, v]) => `${k.replace('_', '-')} ${v.toFixed(2)}`)
    .join(', ');
}

/** The dim line under a Bash row; undefined keeps the row as the engine drew it. */
export function bashRowText(e: LogEntry): string | undefined {
  if (e.feature !== 'bash') return undefined;
  if (e.action === 'allow') return `▸ jevgate fast-lane · ${fmtScores(e.scores)} · ${e.ms ?? '?'}ms`;
  if (e.action === 'pass') return `↷ jevgate → classifier · ${fmtScores(e.scores)}`;
  return undefined;
}

export function kb(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
