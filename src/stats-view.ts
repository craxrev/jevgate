// The /jevgate pane as plain lines: text plus style, no `$`, so the layout is
// unit-testable and the function-hook module only maps lines to Text elements.
import type { BashStats } from './ui-model.ts';

export type Line = { text: string; color?: string; dim?: boolean; bold?: boolean };

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

export const COLORS = { free: undefined, allow: 'green', ok: 'cyan', denied: 'red', unreachable: 'yellow' } as const;

export type StatsView = { session: BashStats; all: BashStats; width: number; entries: number };

export function statsLines(v: StatsView): Line[] {
  const { session: s, all: a } = v;
  const total = (x: BashStats) => x.free + x.ok + x.denied + x.unreachable;
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
  row('ok', s.ok - s.allowed, st, COLORS.ok);
  row('denied', s.denied, st, COLORS.denied);
  if (s.unreachable) row('unreachable', s.unreachable, st, COLORS.unreachable);
  out.push({ text: '' });

  const judged = s.ok + s.denied + s.unreachable;
  const skipped = s.allowed + s.denied;
  out.push({ text: 'Classifier passes avoided', bold: true });
  out.push({ text: ` ${bar(skipped, judged, barW + 12)} ${pct(skipped, judged).padStart(4)}`, color: COLORS.allow });
  out.push({ text: ` ${skipped} of ${judged} judged commands settled by Jev`, dim: true });
  out.push({ text: '' });

  out.push({ text: 'Jev latency', bold: true });
  const sp = spark(s.msRecent.slice(-Math.max(8, barW)));
  out.push({ text: ` ${sp}`, color: COLORS.ok });
  out.push({ text: ` avg ${s.avgMs}ms this session · ${a.avgMs}ms all-time`, dim: true });
  out.push({ text: '' });

  const at = total(a);
  out.push({ text: `All-time · ${at} calls`, bold: true });
  out.push({ text: ` ${bar(a.free, at, barW + 12)} free ${pct(a.free, at)}`, dim: true });
  out.push({ text: ` allow ${a.allowed} · ok ${a.ok - a.allowed} · denied ${a.denied} · unreachable ${a.unreachable}`, dim: true });
  out.push({ text: '' });

  out.push({ text: a.categories.length ? 'Denied by category · all-time' : 'Nothing denied yet', bold: true });
  const maxCat = Math.max(1, ...a.categories.map(([, n]) => n));
  for (const [c, n] of a.categories.slice(0, 8)) {
    out.push({ text: ` ${c.replace(/^file:/, '✎ ').padEnd(28)}${bar(n, maxCat, Math.max(4, barW - 16))} ${String(n).padStart(3)}`, color: COLORS.denied });
  }
  out.push({ text: '' });
  out.push({ text: ` done-check ✗${s.blocks} · subagent ⇢${s.agentDenies}`, dim: true });
  out.push({ text: ` ${v.entries} log entries · Esc closes`, dim: true });
  return out;
}
