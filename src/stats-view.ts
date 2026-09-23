// The /jevgate pane as plain lines: text plus style, no `$`, so the layout is
// unit-testable and the function-hook module only maps lines to Text elements.
import type { BashStats } from './ui-model.ts';

/** One pane line; `dimHead` characters at its start are drawn dim (the chart's empty baseline). */
export type Line = { text: string; color?: string; dim?: boolean; bold?: boolean; dimHead?: number };

const FULL = '█';
const EMPTY = '░';
const SPARK = '▁▂▃▄▅▆▇█';

/** A horizontal bar `width` cells wide, `n` of `total` filled. */
export function bar(n: number, total: number, width: number): string {
  if (width <= 0) return '';
  const filled = total > 0 ? Math.round((width * n) / total) : 0;
  return FULL.repeat(Math.min(width, filled)) + EMPTY.repeat(Math.max(0, width - filled));
}

/** One spark character per value, scaled to the highest. */
export function spark(values: readonly number[]): string {
  const max = Math.max(0, ...values);
  if (!values.length || max === 0) return '';
  return values.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]!).join('');
}

const pct = (n: number, total: number) => (total ? `${Math.round((100 * n) / total)}%` : '');

export const COLORS = { free: undefined, allow: 'green', latency: 'cyan', asked: 'yellow', denied: 'red', unreachable: 'yellow' } as const;

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
  if (s.unreachable) row('unreachable', s.unreachable, st, COLORS.unreachable);
  out.push({ text: ' free    read-only, never judged', dim: true });
  out.push({ text: ' allow   nothing flagged', dim: true });
  out.push({ text: ' asked   flagged, you decided', dim: true });
  out.push({ text: ' denied  refused', dim: true });
  out.push({ text: '' });

  if (s.asked) {
    const pending = s.asked - s.approved - s.rejected;
    out.push({ text: 'Your answers to asks', bold: true });
    out.push({ text: ` approved ${s.approved} · rejected ${s.rejected}${pending > 0 ? ` · unanswered ${pending}` : ''}`, dim: true });
    out.push({ text: '' });
  }
  if (s.unreachable || s.blocked) {
    out.push({ text: 'Not judged by Jev', bold: true });
    if (s.unreachable) out.push({ text: ` handed to Claude Code ${s.unreachable} (Jev unreachable)`, color: COLORS.unreachable });
    if (s.blocked) out.push({ text: ` asked ${s.blocked} (gateway blocked the request)`, color: COLORS.asked });
    out.push({ text: '' });
  }

  out.push({ text: 'Jev latency', bold: true });
  // a fixed frame: empty slots on the left, newest call on the right, so a short session still reads as a chart
  const chartW = barW + 12;
  const recent = s.msRecent.slice(-chartW);
  out.push({ text: ` ${'▁'.repeat(chartW - recent.length)}${spark(recent)}`, color: COLORS.latency, dimHead: 1 + chartW - recent.length });
  out.push({ text: recent.length ? ` last ${recent.length} calls · peak ${Math.max(...recent)}ms` : ' no judged calls yet', dim: true });
  out.push({ text: ` avg ${s.avgMs}ms this session · ${a.avgMs}ms all-time`, dim: true });
  out.push({ text: '' });

  const at = total(a);
  out.push({ text: `All-time · ${at} calls`, bold: true });
  out.push({ text: ` ${bar(a.free, at, barW + 12)} free ${pct(a.free, at)}`, dim: true });
  out.push({ text: ` allow ${a.allowed} · asked ${a.asked} · denied ${a.denied}`, dim: true });
  if (a.unreachable) out.push({ text: ` unreachable ${a.unreachable}`, dim: true });
  out.push({ text: '' });

  const flags = (title: string, rows: [string, number][], color: string) => {
    out.push({ text: title, bold: true });
    const max = Math.max(1, ...rows.map(([, n]) => n));
    for (const [c, n] of rows.slice(0, 6)) {
      out.push({ text: ` ${c.replace(/^file:/, '✎ ').slice(0, 27).padEnd(28)}${bar(n, max, Math.max(4, barW - 16))} ${String(n).padStart(3)}`, color });
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
