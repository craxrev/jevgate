// jevgate function-hook module (early access).
//
// 1. session.compact: replace the compaction summary with the same messages,
//    long tool outputs truncated. Text is never rewritten, calls are never
//    dropped. Jev only ranks which truncated outputs to restore verbatim.
// 2. turn.complete: request compaction early, refresh the status line.
// 3. ui.render: a dim line under each Bash row Jev judged, and a pane
//    reporting a compaction.
//
// Everything UI is best-effort and must never break the hooks it decorates.
// The validator follows `$` only within this file, so all of it lives here.
import type { On, PluginOptions, Register, SessionMessage } from 'claude-code';
import { fromRaw, type Config } from '../src/config.ts';
import { ask, noul, type FetchLike } from '../src/jev.ts';
import {
  candidates,
  apply,
  reductionRatio,
  buildRankState,
  rankQuestions,
  pickRestore,
  type Msg,
} from '../src/compact-core.ts';
import {
  tally,
  footerLabel,
  bashRowText,
  parseLog,
  kb,
  type LogEntry,
  type CompactionRow,
  type CompactionReport,
} from '../src/ui-model.ts';

type Host = Parameters<Parameters<On>[1]>[0];

const PANE_ID = 'jevgate-compaction';
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

/** The newest entries of the decisions log, oldest first. Missing log = empty. */
async function readLog($: Host): Promise<LogEntry[]> {
  const home = (await $.env.get('HOME')) ?? '';
  for (const p of [
    `${home}/.claude/plugins/data/jevgate-jevgate/decisions.jsonl`,
    `${home}/.claude/jevgate/decisions.jsonl`,
  ]) {
    if (!(await $.fs.exists(p))) continue;
    let text = await $.fs.read(p);
    if (text.length > MAX_LOG_CHARS) text = text.slice(text.length - MAX_LOG_CHARS);
    return parseLog(text);
  }
  return [];
}

/** Mutable UI state for one load of the module. */
type UiRuntime = {
  compactions: CompactionReport[];
  rowCache: Map<string, string | undefined>;
  footer: string | undefined;
};

function cacheRows(ui: UiRuntime, entries: readonly LogEntry[]): void {
  for (const en of entries) if (en.tool_use_id) ui.rowCache.set(en.tool_use_id, bashRowText(en));
}

/** Re-read the decisions log; redraw the footer when the tally moved. Decoration: never throws. */
async function refresh($: Host, ui: UiRuntime): Promise<void> {
  try {
    const [entries, session] = await Promise.all([readLog($), $.session.id()]);
    const label = footerLabel(tally(entries, session), ui.compactions.length);
    cacheRows(ui, entries);
    if (label !== ui.footer) {
      ui.footer = label;
      $.ui.invalidate('ui.render');
    }
  } catch {
    // the footer is decoration
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const cfg = fromRaw(options as Record<string, string | number | boolean | readonly string[]>);
  let compacting = false;
  const ui: UiRuntime = { compactions: [], rowCache: new Map(), footer: undefined };
  const compactions = ui.compactions;
  const rowCache = ui.rowCache;

  on('session.compact', async ($, e, next) => {
    if (!cfg.compactEnabled) return next(e);
    const t0 = Date.now();

    // Near the ceiling (engine's own auto-compact, or its precompute for it) a
    // lossy summary beats hitting the wall. Anywhere else there is room, so when
    // nothing can be trimmed the conversation simply stays as it is.
    const nearCeiling = e.trigger === 'auto' || e.trigger === 'precompute';
    const bail = (why: string) => {
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
          const state = buildRankState(messages, cands, cfg.compactTruncateHeadChars);
          const res = await ask(hostFetch($), { apiKey, model: cfg.model }, state, rankQuestions(cands));
          for (const c of cands) scores.set(c.id, noul(res, `keep_${c.id}`));
          const keep = pickRestore(scores, cfg.compactRestoreTopK, cfg.compactRestoreMinScore);
          for (const id of keep) truncate.delete(id);
          restored = keep.size;
          $.ui.log(
            'jevgate compact scores: ' +
              cands.map((c) => `${c.tool}:${(scores.get(c.id) ?? 0).toFixed(2)}${keep.has(c.id) ? '*' : ''}`).join(' '),
          );
        } catch (err) {
          // Jev is optional here: without it every candidate is truncated.
          $.ui.log(`jevgate compact: Jev ranking skipped (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      const out = apply(messages, truncate, cfg.compactTruncateHeadChars);
      const ratio = reductionRatio(messages, out);
      const ms = Date.now() - t0;
      const summary = `${truncate.size} truncated, ${restored} restored, ${Math.round(ratio * 100)}% smaller, ${ms}ms`;
      if (ratio < cfg.compactMinReductionRatio) return bail(`only ${summary}`);
      $.ui.toast(`jevgate: kept all ${out.length} messages, no summary (${summary})`, { timeoutMs: 8000 });

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

  // After each Bash call settles, the gate's log entry exists: tick the footer now, not at turn end.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e);
    await refresh($, ui);
    return result;
  });

  on('turn.complete', async ($, e, next) => {
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

  on('ui.render', { component: 'ToolUse', props: { tool: 'Bash' } }, async ($, e, next) => {
    const engineRow = await next(e);
    try {
      if (!rowCache.has(e.requestId)) {
        cacheRows(ui, await readLog($));
        if (!rowCache.has(e.requestId)) rowCache.set(e.requestId, undefined);
      }
      const line = rowCache.get(e.requestId);
      if (!line) return engineRow;
      const { Box, Text } = $.ui.resolve(e);
      return h(Box, { flexDirection: 'column' }, engineRow, h(Text, { dimColor: true, wrap: 'wrap' }, `  ${line}`));
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
    return h(
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
