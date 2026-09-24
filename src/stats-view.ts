// The /jevgate pane as plain lines: text plus style, no `$`, so the layout is
// unit-testable and the function-hook module only maps lines to Text elements.
import { flagLabel, type BashStats, type Timing } from './ui-model.ts';

export type Segment = { text: string; color?: string; dim?: boolean };
/**
 * One pane line; `dimHead` characters at its start are drawn dim (the chart's empty baseline).
 * With `segments`, those are drawn instead and `text` is their concatenation.
 */
export type Line = { text: string; color?: string; dim?: boolean; bold?: boolean; dimHead?: number; segments?: Segment[] };

const FULL = '█';
const EMPTY = '░';
const SPARK = '▁▂▃▄▅▆▇█';

/** A horizontal bar `width` cells wide, `n` of `total` filled. */
export function bar(n: number, total: number, width: number): string {
  if (width <= 0) return '';
  const filled = total > 0 ? Math.round((width * n) / total) : 0;
  return FULL.repeat(Math.min(width, filled)) + EMPTY.repeat(Math.max(0, width - filled));
}

/**
 * One block per value, scaled to the 90th percentile so a single slow call does
 * not flatten the rest (above it is a full block); under 10 values, to the highest.
 */
export function spark(values: readonly number[]): string {
  if (!values.length) return '';
  const sorted = [...values].sort((a, b) => a - b);
  const top = sorted[sorted.length - 1]!;
  if (top <= 0) return '';
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))]!;
  const max = values.length < 10 || p90 <= 0 ? top : p90;
  return values.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]!).join('');
}

/** The parts of a call in the order they happen; an unanswered call ends in its wait for no answer. */
export const TIMING_PARTS = [
  { name: 'prep', dim: true },
  { name: 'connect', color: 'blue' },
  { name: 'network', color: 'magenta' },
  { name: 'Jev', color: 'cyan' },
] as const;

function parts(t: Timing): number[] {
  const rest = Math.max(0, t.ms - t.prep - t.connect - (t.server ?? 0));
  return t.answered ? [t.prep, t.connect, rest, t.server ?? 0] : [t.prep, t.connect, rest];
}

/** A bar `t.ms / max` of `width` cells, one colored run per part. */
export function timingBar(t: Timing, max: number, width: number): Segment[] {
  const out: Segment[] = [];
  let cum = 0;
  let drawn = 0;
  parts(t).forEach((ms, i) => {
    cum += ms;
    const to = max > 0 ? Math.min(width, Math.round((width * cum) / max)) : 0;
    if (to > drawn) {
      const p = TIMING_PARTS[i]!;
      const n = to - drawn;
      out.push(!t.answered && i === 2 ? { text: '·'.repeat(n), color: COLORS.unreachable } : { text: '█'.repeat(n), color: 'color' in p ? p.color : undefined, dim: 'dim' in p });
      drawn = to;
    }
  });
  return out;
}

/** The mean of each part over answered calls. */
export function meanTiming(ts: readonly Timing[]): Timing | undefined {
  const a = ts.filter((t) => t.answered);
  if (!a.length) return undefined;
  const m = (f: (t: Timing) => number) => Math.round(a.reduce((n, t) => n + f(t), 0) / a.length);
  return { ms: m((t) => t.ms), prep: m((t) => t.prep), connect: m((t) => t.connect), server: m((t) => t.server ?? 0), answered: true, tries: 1 };
}

const pct = (n: number, total: number) => (total ? `${Math.round((100 * n) / total)}%` : '');

export const COLORS = { free: undefined, allow: 'green', latency: 'cyan', asked: 'yellow', denied: 'red', unreachable: 'claude' } as const;

export type StatsView = { session: BashStats; all: BashStats; width: number; entries: number };

export function statsLines(v: StatsView): Line[] {
  const { session: s, all: a } = v;
  const total = (x: BashStats) => x.free + x.allowed + x.asked + x.denied + x.unreachable;
  const width = Math.max(30, v.width - 2);
  const barW = Math.max(6, width - 24);
  const out: Line[] = [];
  const row = (label: string, n: number, t: number, color?: string, dim?: boolean) =>
    out.push({ text: ` ${label.padEnd(11)}${bar(n, t, barW)} ${String(n).padStart(4)} ${pct(n, t).padStart(4)}`, color, dim });

  out.push({ text: 'jevgate', bold: true });
  out.push({ text: '' });

  const st = total(s);
  out.push({ text: `This session · ${st} calls`, bold: true });
  row('free', s.free, st, COLORS.free, true);
  row('allow', s.allowed, st, COLORS.allow);
  row('asked', s.asked, st, COLORS.asked);
  row('denied', s.denied, st, COLORS.denied);
  if (s.unreachable) row('passed on', s.unreachable, st, COLORS.unreachable);
  out.push({ text: ' free       read-only, never judged', dim: true });
  out.push({ text: ' allow      nothing flagged', dim: true });
  out.push({ text: ' asked      flagged, you decided', dim: true });
  out.push({ text: ' denied     refused', dim: true });
  if (s.unreachable) out.push({ text: ' passed on  no verdict, left to Claude Code', dim: true });
  out.push({ text: '' });

  if (s.asked) {
    const pending = s.asked - s.approved - s.rejected;
    out.push({ text: 'Your answers to asks', bold: true });
    out.push({ text: ` approved ${s.approved} · rejected ${s.rejected}${pending > 0 ? ` · unanswered ${pending}` : ''}`, dim: true });
    out.push({ text: '' });
  }

  // one window for the whole section: the last calls that fit the width
  const chartW = barW + 12;
  const recent = s.msRecent.slice(-chartW);
  out.push({ text: recent.length ? `Jev latency · last ${recent.length} calls` : 'Jev latency', bold: true });
  // a fixed frame: empty slots on the left, newest call on the right, so a short session still reads as a chart
  out.push({ text: ` ${'▁'.repeat(chartW - recent.length)}${spark(recent)}`, color: COLORS.latency, dimHead: 1 + chartW - recent.length });
  if (!recent.length) out.push({ text: ' no judged calls yet', dim: true });

  const avg = meanTiming(s.timingRecent.slice(-chartW).filter((t) => t !== undefined));
  if (s.lastCall || avg) {
    const max = Math.max(s.lastCall?.ms ?? 0, avg?.ms ?? 0);
    // Jev's own time after the total, in Jev's color; both padded, so the bar starts in one place
    const jevColor = TIMING_PARTS[3].color;
    const tbar = (label: string, t: Timing) => {
      const jev = t.server !== undefined ? `${String(t.server).padStart(4)}ms` : '      ';
      const segs: Segment[] = [
        { text: ` ${label.padEnd(5)}${String(t.ms).padStart(6)}ms` },
        { text: t.server !== undefined ? ' · ' : '   ', dim: true },
        { text: jev, color: jevColor },
        { text: ' ' },
        ...timingBar(t, max, chartW - 23),
      ];
      out.push({ text: segs.map((g) => g.text).join(''), segments: segs });
    };
    if (s.lastCall) tbar('last', s.lastCall);
    if (avg) tbar('avg', avg);
    const legend: Segment[] = [];
    // connect only while a call in view connected on its own (0.4); with one connection kept open it is never drawn
    const shown = [s.lastCall, avg].some((t) => (t?.connect ?? 0) > 0) ? TIMING_PARTS : TIMING_PARTS.filter((p) => p.name !== 'connect');
    for (const p of shown) legend.push({ text: ' █', color: 'color' in p ? p.color : undefined, dim: 'dim' in p }, { text: ` ${p.name} `, dim: true });
    if (recent.length) legend.push({ text: `· peak ${Math.max(...recent)}ms`, dim: true });
    out.push({ text: legend.map((g) => g.text).join(''), segments: legend });
    if (s.lastCall && !s.lastCall.answered) {
      out.push({ text: ` last call: Jev did not answer${s.lastCall.tries > 1 ? ` (${s.lastCall.tries} tries)` : ''}`, color: COLORS.unreachable });
    }
  }
  if (s.avgMs || a.avgMs) out.push({ text: ` avg this session ${s.avgMs ? `${s.avgMs}ms` : '–'} · all-time ${a.avgMs}ms`, dim: true });
  out.push({ text: '' });

  const at = total(a);
  out.push({ text: `All-time · ${at} calls`, bold: true });
  out.push({ text: ` ${bar(a.free, at, barW + 12)} free ${pct(a.free, at)}`, dim: true });
  out.push({ text: ` allow ${a.allowed} · asked ${a.asked} · denied ${a.denied}`, dim: true });
  if (a.unreachable) out.push({ text: ` passed on ${a.unreachable}`, dim: true });
  out.push({ text: '' });

  const flags = (title: string, rows: [string, number][], color: string) => {
    out.push({ text: title, bold: true });
    const max = Math.max(1, ...rows.map(([, n]) => n));
    for (const [c, n] of rows.slice(0, 6)) {
      out.push({ text: ` ${flagLabel(c, 27).padEnd(28)}${bar(n, max, Math.max(4, barW - 16))} ${String(n).padStart(3)}`, color });
    }
    out.push({ text: '' });
  };
  if (a.categories.length) flags('Denied by flag · all-time', a.categories, COLORS.denied);
  else out.push({ text: 'Nothing denied yet', bold: true }, { text: '' });
  if (a.askedBy.length) flags('Asked by flag · all-time', a.askedBy, COLORS.asked);
  out.push({ text: ` done-check ✗${s.blocks} · subagent ⇢${s.agentDenies}`, dim: true });
  out.push({ text: ` ${v.entries} log entries · Esc closes`, dim: true });
  return out;
}
