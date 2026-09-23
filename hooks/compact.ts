// jevgate function-hook module (early access).
//
// 1. session.compact: replace the compaction summary with the same messages,
//    long tool outputs truncated. Text is never rewritten, calls are never
//    dropped. Jev only ranks which truncated outputs to restore verbatim.
// 2. turn.complete: request compaction early, refresh the status line.
//    turn.start: while a turn runs, redraw within a second of a gate or the done-check deciding.
// 3. ui.render: a dim line under each judged Bash or file-tool result, and a pane
//    reporting a compaction.
// 4. /jevgate: a registered slash command that opens a stats pane, no model
//    turn and no shell involved.
//
// Everything UI is best-effort and must never break the hooks it decorates.
// The validator follows `$` only within this file, so all of it lives here.
import type { EngineInterface, On, PluginOptions, Register, RenderElement, SessionMessage } from 'claude-code';
import { fromRaw, type Config } from '../src/config.ts';
import { ask, type FetchLike } from '../src/jev.ts';
import {
  candidates,
  apply,
  reductionRatio,
  buildRankState,
  rankQuestions,
  rankScores,
  rankable,
  pickRestore,
  type Msg,
} from '../src/compact-core.ts';
import { statsLines } from '../src/stats-view.ts';
import {
  tally,
  footerLabel,
  bashRowText,
  groupSummary,
  ASK_ANSWERS,
  askAnswer,
  parseLog,
  kb,
  bashStats,
  type BashStats,
  type LogEntry,
  type CompactionRow,
  type CompactionReport,
} from '../src/ui-model.ts';

type Host = EngineInterface;

/** `h` is the loosely typed JSX factory; a render hook must hand back an element. */
const el = (...args: Parameters<typeof h>): RenderElement => h(...args) as RenderElement;

const PANE_ID = 'jevgate-compaction';
const STATS_PANE_ID = 'jevgate-stats';
const MAX_LOG_CHARS = 512 * 1024;

async function resolveApiKey($: Host, cfg: Config): Promise<string | undefined> {
  if (cfg.apiKey) return cfg.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const v = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function hostFetch($: Host): FetchLike {
  return async (url, init) => {
    const r = await $.http.fetch(url, init);
    return { status: r.status, ok: r.ok, text: r.text };
  };
}

/** Maps rebuilt messages back onto the engine's shape; untouched ones keep their handle. */
function toSession(input: readonly SessionMessage[], output: readonly Msg[]): SessionMessage[] {
  const own = new Set<Msg>(input as readonly Msg[]);
  return output.map((m) => (own.has(m) ? (m as SessionMessage) : (m as SessionMessage)));
}

async function logCandidates($: Host): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? '';
  const data = await $.env.get('CLAUDE_PLUGIN_DATA');
  // the command hooks write to their plugin data dir: `jevgate-jevgate` when installed, `jevgate-inline` under --plugin-dir
  const dirs = [data, `${home}/.claude/plugins/data/jevgate-jevgate`, `${home}/.claude/plugins/data/jevgate-inline`, `${home}/.claude/jevgate`];
  return [...new Set(dirs.filter((d): d is string => !!d).map((d) => `${d}/decisions.jsonl`))];
}

/** The newest entries of every decisions log, merged oldest first. Missing logs = empty. */
async function readLog($: Host): Promise<LogEntry[]> {
  const out: LogEntry[] = [];
  for (const p of await logCandidates($)) {
    if (!(await $.fs.exists(p))) continue;
    let text = await $.fs.read(p);
    if (text.length > MAX_LOG_CHARS) text = text.slice(text.length - MAX_LOG_CHARS);
    out.push(...parseLog(text));
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Appends one decision line to the same log the command hooks write. `$.fs` has no append, so read + write; best effort. */
async function appendDecision($: Host, entry: Record<string, unknown>, near?: string): Promise<void> {
  try {
    // `near`: text of an entry this one belongs with; its log wins (the gates write where Claude Code's plugin data dir is)
    let path: string | undefined;
    let existing = '';
    for (const p of await logCandidates($)) {
      if (!(await $.fs.exists(p))) continue;
      const text = await $.fs.read(p);
      if (path === undefined || (near && text.includes(near))) {
        path = p;
        existing = text;
        if (!near || text.includes(near)) break;
      }
    }
    path ??= (await logCandidates($))[0]!;
    await $.fs.write(path, existing + JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    $.ui.log(`jevgate: could not log (${err instanceof Error ? err.message : String(err)})`);
  }
}

const GUARDED = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

/** Mutable UI state for one load of the module. */
type UiRuntime = {
  compactions: CompactionReport[];
  rowCache: Map<string, string | undefined>;
  /** Calls drawn inside a group: their expanded rows are ToolUse rows, which get the line. */
  grouped: Set<string>;
  footer: string | undefined;
  stats?: { session: BashStats; all: BashStats; sessionId: string; entries: number };
};

/** Fills the row lines from the log; true when a line appeared or changed, so drawn rows need a redraw. */
function cacheRows(ui: UiRuntime, entries: readonly LogEntry[]): boolean {
  let changed = false;
  for (const en of entries) {
    if (!en.tool_use_id) continue;
    const answer = ASK_ANSWERS[en.action as keyof typeof ASK_ANSWERS];
    if (answer) {
      const asked = ui.rowCache.get(en.tool_use_id);
      if (asked && !asked.endsWith(answer)) {
        ui.rowCache.set(en.tool_use_id, `${asked} · ${answer}`);
        changed = true;
      }
      continue;
    }
    const line = bashRowText(en);
    if (ui.rowCache.get(en.tool_use_id) !== line) changed ||= line !== undefined;
    ui.rowCache.set(en.tool_use_id, line);
  }
  return changed;
}

/** The dim line for one call, reading the log when the call is not cached yet. */
async function lineFor($: Host, ui: UiRuntime, id: string): Promise<string | undefined> {
  if (!ui.rowCache.has(id)) {
    cacheRows(ui, await readLog($));
    if (!ui.rowCache.has(id)) ui.rowCache.set(id, undefined); // refresh() fills it once the log has it
  }
  return ui.rowCache.get(id);
}

/** Re-read the decisions log; redraw the footer when the tally moved. Decoration: never throws. */
async function refresh($: Host, ui: UiRuntime): Promise<void> {
  try {
    const [entries, session] = await Promise.all([readLog($), $.session.id()]);
    const label = footerLabel(tally(entries, session), ui.compactions.length);
    const rowsChanged = cacheRows(ui, entries);
    let changed = label !== ui.footer || rowsChanged;
    ui.footer = label;
    if (ui.stats && ui.stats.entries !== entries.length) {
      ui.stats = { session: bashStats(entries, session), all: bashStats(entries), sessionId: session, entries: entries.length };
      changed = true;
    }
    if (changed) $.ui.invalidate('ui.render');
  } catch {
    // the footer is decoration
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const cfg = fromRaw(options as Record<string, string | number | boolean | readonly string[]>);
  let compacting = false;
  const ui: UiRuntime = { compactions: [], rowCache: new Map(), grouped: new Set(), footer: undefined };
  const compactions = ui.compactions;
  const rowCache = ui.rowCache;

  on('session.compact', async ($, e, next) => {
    if (!cfg.compactEnabled) return next(e);
    const t0 = Date.now();

    // Near the ceiling (engine's own auto-compact, or its precompute for it) a
    // lossy summary beats hitting the wall. Anywhere else there is room, so when
    // nothing can be trimmed the conversation simply stays as it is.
    const nearCeiling = e.trigger === 'auto' || e.trigger === 'precompute';
    const session = await $.session.id().catch(() => undefined);
    const rank: Record<string, unknown> = {};
    const bail = (why: string) => {
      void appendDecision($, { feature: 'compact', action: nearCeiling ? 'summary' : 'kept-as-is', session, trigger: e.trigger, messages: e.messages.length, reason: why, ...rank, ms: Date.now() - t0 });
      if (nearCeiling) {
        $.ui.toast(`jevgate: built-in summary (${why})`, { timeoutMs: 8000 });
        return next(e);
      }
      $.ui.toast(`jevgate: ${why}, conversation kept as is`, { timeoutMs: 8000 });
      return { skip: `jevgate: ${why}` };
    };

    try {
      const messages = e.messages as readonly Msg[];
      const cands = candidates(messages, {
        preserveRecent: cfg.compactPreserveRecent,
        headChars: cfg.compactTruncateHeadChars,
      });
      if (cands.length === 0) return bail('nothing to truncate');

      const truncate = new Set(cands.map((c) => c.id));
      const scores = new Map<string, number>();
      let restored = 0;
      if (cfg.compactUseJev) {
        try {
          const apiKey = await resolveApiKey($, cfg);
          if (!apiKey) throw new Error('no TYPESAFE_API_KEY');
          const ranked = rankable(cands);
          const state = buildRankState(messages, ranked, cfg.compactTruncateHeadChars);
          const questions = rankQuestions(ranked);
          rank.jev_body_chars = JSON.stringify({ state, questions }).length;
          rank.ranked = ranked.length;
          const tJev = Date.now();
          const res = await ask(hostFetch($), { apiKey, model: cfg.model }, state, questions);
          rank.jev_ms = Date.now() - tJev;
          const r = rankScores(res, ranked, cfg.compactRestoreMinConfidence);
          for (const [id, s] of r.scores) scores.set(id, s);
          const vals = [...scores.values()].sort((a, b) => b - a);
          rank.jev_choice = { choice: r.choice, confidence: r.confidence, none: r.none };
          rank.jev_scores = { n: vals.length, max: vals[0] ?? 0, top5: vals.slice(0, 5) };
          rank.jev_usage = res.usage;
          const keep = pickRestore(scores, cfg.compactRestoreTopK, cfg.compactRestoreMinScore);
          for (const id of keep) truncate.delete(id);
          restored = keep.size;
          $.ui.log(
            'jevgate compact scores: ' +
              cands.map((c) => `${c.tool}:${(scores.get(c.id) ?? 0).toFixed(2)}${keep.has(c.id) ? '*' : ''}`).join(' '),
          );
        } catch (err) {
          // Jev is optional here: without it every candidate is truncated.
          rank.jev_error = err instanceof Error ? err.message : String(err);
          $.ui.log(`jevgate compact: Jev ranking skipped (${rank.jev_error})`);
        }
      }

      const out = apply(messages, truncate, cfg.compactTruncateHeadChars);
      const ratio = reductionRatio(messages, out);
      const ms = Date.now() - t0;
      const summary = `${truncate.size} truncated, ${restored} restored, ${Math.round(ratio * 100)}% smaller, ${ms}ms`;
      if (ratio < cfg.compactMinReductionRatio) return bail(`only ${summary}`);
      $.ui.toast(`jevgate: kept all ${out.length} messages, no summary (${summary})`, { timeoutMs: 8000 });
      void appendDecision($, {
        feature: 'compact', action: 'verbatim', session, trigger: e.trigger, messages: out.length,
        candidates: cands.length, truncated: truncate.size, restored, ratio: Math.round(ratio * 1000) / 1000,
        chars_before: messages.reduce((a, m) => a + m.text.length + (m.toolResults ?? []).reduce((b, r) => b + r.text.length, 0), 0),
        ...rank, ms,
      });

      const rows: CompactionRow[] = cands.map((c) => {
        const isTruncated = truncate.has(c.id);
        const input = JSON.stringify(c.input);
        return {
          tool: c.tool,
          input: input.length > 60 ? input.slice(0, 60) + '…' : input,
          chars: c.chars,
          kept: isTruncated ? cfg.compactTruncateHeadChars : c.chars,
          score: scores.get(c.id),
          restored: !isTruncated,
        };
      });
      compactions.push({ at: new Date().toISOString(), trigger: e.trigger, rows, ratio, ms, messages: out.length });
      if (compactions.length > 10) compactions.shift();
      try {
        await $.ui.open({ id: PANE_ID, title: 'jevgate compaction', closeOnEscape: true, rows: Math.min(20, rows.length + 3) });
        $.ui.invalidate('ui.render');
      } catch {
        // pane is decoration
      }
      return { messages: toSession(e.messages, out) };
    } catch (err) {
      return bail(err instanceof Error ? err.message : String(err));
    }
  });

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'jevgate', description: 'jevgate guard tally: this session and all-time', immediate: true });
    } catch (err) {
      $.ui.log(`jevgate: /jevgate not registered (${err instanceof Error ? err.message : String(err)})`);
    }
    return next(e);
  });

  on('command.run', { command: 'jevgate' }, async ($) => {
    const [entries, sessionId] = await Promise.all([readLog($), $.session.id()]);
    ui.stats = { session: bashStats(entries, sessionId), all: bashStats(entries), sessionId, entries: entries.length };
    const rows = statsLines({ session: ui.stats.session, all: ui.stats.all, width: 80, entries: ui.stats.entries }).length + 2;
    try {
      await $.ui.open({ id: STATS_PANE_ID, title: 'jevgate', closeOnEscape: true, rows });
      $.ui.invalidate('ui.render');
      return {};
    } catch {
      // no panel surface: fall back to a text row
      const s = ui.stats;
      const line = (label: string, x: BashStats) =>
        `${label}: free ${x.free} · ok ${x.ok} (allow ${x.allowed}) · asked ${x.asked} (✓${x.approved} ✗${x.rejected}) · denied ${x.denied} · unreachable ${x.unreachable} · avg ${x.avgMs}ms`;
      return { text: `${line('session', s.session)}\n${line('all-time', s.all)}` };
    }
  });

  on('ui.render', { component: 'Pane', requestId: STATS_PANE_ID }, async ($, e, next) => {
    const s = ui.stats;
    if (!s) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const lines = statsLines({ session: s.session, all: s.all, width: e.props.bodyColumns - 2, entries: s.entries });
    return el(
      Box,
      { flexDirection: 'column', width: e.props.bodyColumns, paddingX: 1 },
      ...lines.map((l) => h(Text, { color: l.color, dimColor: l.dim, bold: l.bold, wrap: 'truncate-end' }, l.text || ' ')),
    );
  });

  // No event reaches this module when a command hook decides (the built-in sec-default runs
  // classic hooks without passing them on), and a done-check block keeps the turn going. So while
  // a main-loop turn runs (subagents raise no turn.start), look at the logs once a second and redraw when they changed.
  let ticker: { cancel: () => void } | undefined;
  let seen = '';
  on('turn.start', async ($, e, next) => {
    if (!ticker) {
      ticker = $.clock.every(1000, () => {
        void (async () => {
          try {
            const stamp = (await Promise.all((await logCandidates($)).map(async (p) => ((await $.fs.exists(p)) ? (await $.fs.stat(p)).mtimeMs : 0)))).join(',');
            if (stamp === seen) return;
            seen = stamp;
            await refresh($, ui);
          } catch {
            // decoration
          }
        })();
      });
    }
    return next(e);
  });

  // After each guarded call settles, the gate's log entry exists: tick the footer now, not at turn end.
  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    await refresh($, ui);
    try {
      // an asked call settles once you answered the prompt
      const answer = rowCache.get(e.tool_use_id)?.startsWith('? ') ? askAnswer(result) : undefined;
      if (answer) {
        const session = await $.session.id();
        await appendDecision($, { feature: e.tool === 'Bash' ? 'bash' : 'file', action: answer, session, tool_use_id: e.tool_use_id }, `"tool_use_id":"${e.tool_use_id}"`);
        await refresh($, ui);
      }
    } catch {
      // decoration
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      ticker?.cancel();
      ticker = undefined;
    }
    await refresh($, ui);
    if (!cfg.compactEnabled || compacting) return next(e);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) >= cfg.compactAtPercent) {
        compacting = true;
        await $.session.compact();
      }
    } catch (err) {
      $.ui.log(`jevgate: early compact skipped (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      compacting = false;
    }
    return next(e);
  });

  // The dim mode labels at the right of the prompt footer: add ours as one more label.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!ui.footer) return next(e);
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, ui.footer] } });
  });

  type Parts = { Box: Parameters<typeof h>[0]; Text: Parameters<typeof h>[0] };
  const withLines = ({ Box, Text }: Parts, row: RenderElement, lines: readonly string[]): RenderElement =>
    lines.length ? el(Box, { flexDirection: 'column' }, row, ...lines.map((l) => h(Text, { dimColor: true, wrap: 'wrap' }, `  ${l}`))) : row;

  // A standalone row: the line under its result.
  for (const tool of GUARDED) {
    on('ui.render', { component: 'ToolResult', props: { tool } }, async ($, e, next) => {
      const engineRow = await next(e);
      try {
        const line = await lineFor($, ui, e.requestId);
        return line ? withLines($.ui.resolve(e), engineRow, [line]) : engineRow;
      } catch {
        return engineRow;
      }
    });
  }

  // A folded run of calls (`Ran 2 shell commands`): one summary line; expanded, each row gets its own.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const engineRow = await next(e);
    try {
      const ids = e.props.calls.filter((c) => GUARDED.has(c.tool) && c.tool_use_id).map((c) => c.tool_use_id!);
      for (const id of ids) ui.grouped.add(id);
      if (e.props.isExpanded || !ids.length) return engineRow;
      return withLines($.ui.resolve(e), engineRow, groupSummary(await Promise.all(ids.map((id) => lineFor($, ui, id)))));
    } catch {
      return engineRow;
    }
  });
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const engineRow = await next(e);
    try {
      if (!ui.grouped.has(e.props.tool_use_id)) return engineRow;
      const line = await lineFor($, ui, e.props.tool_use_id);
      return line ? withLines($.ui.resolve(e), engineRow, [line]) : engineRow;
    } catch {
      return engineRow;
    }
  });

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const report = compactions[compactions.length - 1];
    if (!report) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const truncated = report.rows.filter((r) => !r.restored).length;
    const restored = report.rows.length - truncated;
    const rows = report.rows.map((r) =>
      h(
        Text,
        { dimColor: !r.restored, wrap: 'truncate' },
        `${r.restored ? '★' : '·'} ${r.tool.padEnd(10)} ${kb(r.chars).padStart(6)} → ${kb(r.kept).padStart(5)}  ${
          r.score === undefined ? '         ' : `keep ${r.score.toFixed(2)}`
        }  ${r.input}`,
      ),
    );
    return el(
      Box,
      { flexDirection: 'column', width: e.props.bodyColumns, paddingX: 1 },
      h(
        Text,
        { bold: true },
        `jevgate compaction (${report.trigger}) · ${truncated} truncated, ${restored} restored · ${Math.round(report.ratio * 100)}% smaller · ${report.ms}ms · ${report.messages} messages kept`,
      ),
      h(Text, { dimColor: true }, '★ restored verbatim by Jev   · truncated to head + note   (Esc closes)'),
      ...rows,
    );
  });
};
