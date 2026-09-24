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
import { logLines, type Decision } from '../src/log.ts';
import { CANCEL, LATER, SUMMARY, TRIM, choiceOf, snoozeTo, type CompactChoice } from '../src/compact-ask.ts';
import { ask, JevTransientError, type FetchLike } from '../src/jev.ts';
import { judgeBash, judgeFile, type GateHost } from '../src/gate.ts';
import { doneCheck } from '../src/done.ts';
import { buildState as agentState, QUESTIONS as AGENT_QUESTIONS, decide as decideAgent } from '../src/agent-policy.ts';
import { matchFragment, safeId, verdictText } from '../src/verdict.ts';
import { recentTurns, turnsOf, type Row } from '../src/transcript.ts';
import type { Runner } from '../src/bash-context.ts';
import type { FileInput } from '../src/file-policy.ts';
import {
  candidates,
  apply,
  reductionRatio,
  buildRankState,
  rankQuestions,
  rankScores,
  rankable,
  fitBudget,
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
    // header names lowercased, as the gate looks them up
    const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, ok: r.ok, text: r.text, headers };
  };
}

/** A program through `$.process.run`: stdout, or undefined when it fails (`anyExit`: whatever the exit code). */
function hostRunner($: Host): Runner {
  return async (program, args, cwd, opts) => {
    try {
      const r = await $.process.run([program, ...args], { cwd, timeoutMs: 5000 });
      return r.exitCode === 0 || opts?.anyExit ? r.stdout : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * `p`, or a rejection once `ms` passed. The timer is dropped as soon as `p`
 * settles: a `$.clock.sleep` counts against the hook's budget, `p`'s wait does not.
 */
async function timed<T>($: Host, p: Promise<T>, ms: number): Promise<T> {
  const ctl = new AbortController();
  const timeout = $.clock.sleep(ms, { signal: ctl.signal }).then(() => {
    throw new JevTransientError(`Jev did not answer within ${ms}ms`);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    ctl.abort();
  }
}

/** Maps rebuilt messages back onto the engine's shape; untouched ones keep their handle. */
function toSession(input: readonly SessionMessage[], output: readonly Msg[]): SessionMessage[] {
  const own = new Set<Msg>(input as readonly Msg[]);
  return output.map((m) => (own.has(m) ? (m as SessionMessage) : (m as SessionMessage)));
}

/** Where jevgate keeps its logs, fixed: the module cannot learn the plugin data dir, and a guess is wrong for some installs. */
async function ownDataDir($: Host): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/.claude/jevgate`;
}

/** Prepared once per load: made owner-only, files older than an hour dropped. */
let runReady: Promise<string> | undefined;

/**
 * Where the module and the sh hooks hand over verdicts and pending free calls:
 * a fixed place both work out from HOME. The plugin data dir is no good, since
 * the module can only guess it, and a directory-marketplace install guesses wrong.
 */
function runDir($: Host): Promise<string> {
  runReady ??= (async () => {
    const dir = `${await ownDataDir($)}/run`;
    await $.process.run(
      ['sh', '-c', 'umask 077; mkdir -p "$1/verdicts" "$1/pending" && chmod 700 "$1" "$1/verdicts" "$1/pending" && find "$1" -type f -mmin +60 -delete', 'jevgate', dir],
      { timeoutMs: 5000 },
    );
    return dir;
  })();
  return runReady;
}

async function dataDirs($: Host): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? '';
  // before 0.5.2 the logs sat in the plugin data dir: `jevgate-jevgate` installed, `jevgate-inline` under --plugin-dir
  const dirs = [await ownDataDir($), `${home}/.claude/plugins/data/jevgate-jevgate`, `${home}/.claude/plugins/data/jevgate-inline`];
  return [...new Set(dirs)];
}

/** stats.jsonl, and ui.jsonl where versions 0.4.8 to 0.4.10 wrote answers and compactions. */
async function logFiles($: Host): Promise<string[]> {
  return (await dataDirs($)).flatMap((d) => [`${d}/stats.jsonl`, `${d}/ui.jsonl`]);
}

/** The newest entries of every stats and UI log, merged oldest first. Missing logs = empty. */
async function readLog($: Host): Promise<LogEntry[]> {
  const out: LogEntry[] = [];
  for (const p of await logFiles($)) {
    if (!(await $.fs.exists(p))) continue;
    let text = await $.fs.read(p);
    if (text.length > MAX_LOG_CHARS) text = text.slice(text.length - MAX_LOG_CHARS);
    out.push(...parseLog(text));
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** The `log` option, set by `register`: whether the full log is written. */
const fullLog = { on: false };

/** Appends for real (`cat >>`): several sessions write the same files, and `$.fs` only rewrites whole ones. */
async function appendText($: Host, path: string, text: string): Promise<void> {
  const r = await $.process.run(['sh', '-c', 'umask 077; mkdir -p "$(dirname "$1")" && cat >> "$1"', 'jevgate', path], { stdin: text, timeoutMs: 5000 });
  if (r.exitCode !== 0) throw new Error(`append to ${path} exited ${r.exitCode}`);
}

/** Chains this module's appends, so its lines land in the order they were logged. */
let appends: Promise<void> = Promise.resolve();

/** Logs one decision: its stats fields to stats.jsonl, the whole entry to the full log when that is on. Best effort. */
function appendDecision($: Host, entry: Decision): Promise<void> {
  const lines = logLines(entry, fullLog.on);
  appends = appends.then(async () => {
    try {
      const dir = await ownDataDir($);
      await appendText($, `${dir}/stats.jsonl`, lines.stats);
      if (lines.full) await appendText($, `${dir}/decisions-v2.jsonl`, lines.full);
    } catch (err) {
      $.ui.log(`could not log (${err instanceof Error ? err.message : String(err)})`);
    }
  });
  return appends;
}

const GUARDED = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

const GUARDED_TOOL = new RegExp(`^(${[...GUARDED].join('|')})$`);

/** Rejects once `signal` aborts: raced against a wait that cannot be cancelled itself. */
function abandoned(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const stop = () => reject(new Error('compaction abandoned'));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

/** What the guards keep for one load of the module. */
type GuardState = {
  cfg: Config;
  /** Looked up once per load; null until then. */
  apiKey: string | undefined | null;
  /** The person's request the done-check judges against, kept across its own follow-ups. */
  request?: string;
  /** Follow-ups sent for `request`, and the latest one's text, so its turn is not taken for a new request. */
  followUps: number;
  followUp?: string;
};

async function key($: Host, st: GuardState): Promise<string | undefined> {
  if (st.apiKey === null) st.apiKey = await resolveApiKey($, st.cfg);
  return st.apiKey;
}

async function gateHost($: Host, st: GuardState): Promise<GateHost> {
  const { cfg } = st;
  return {
    cfg,
    apiKey: await key($, st),
    run: hostRunner($),
    fetch: hostFetch($),
    exists: (p) => $.fs.exists(p),
    rulesFile: async () => {
      if (!cfg.rulesFile) return undefined;
      try {
        return JSON.parse(await $.fs.read(cfg.rulesFile));
      } catch {
        return undefined;
      }
    },
    turns: async () => turnsOf((await $.session.messages()) as Row[]),
    cwd: await $.session.cwd(),
    roots: await scopeRoots($),
    home: (await $.env.get('HOME')) ?? undefined,
    timed: (p, ms) => timed($, p, ms),
  };
}

/** Where the session started (a shell `cd` does not move it) and the settings' added directories: see scope.ts. */
async function scopeRoots($: Host): Promise<string[]> {
  const roots = [await $.session.root()];
  try {
    const home = (await $.env.get('HOME')) ?? '';
    const dirs = ((await $.settings.read())['permissions'] as { additionalDirectories?: unknown } | undefined)?.additionalDirectories;
    for (const d of Array.isArray(dirs) ? dirs : []) {
      if (typeof d === 'string' && d) roots.push(d.startsWith('~/') ? home + d.slice(1) : d);
    }
  } catch {
    // no added directories: their paths are judged instead
  }
  return roots;
}

/**
 * Judges a guarded call and leaves the verdict for answer.sh, before the call goes on to
 * Claude Code's permission step. Throws when it cannot: then there is no verdict, and
 * answer.sh refuses where nothing else judges (bypass), or leaves the call to Claude Code.
 */
async function gate($: Host, st: GuardState, e: { tool: string; tool_use_id: string }): Promise<Decision | undefined> {
  const input = e as unknown as Record<string, unknown>;
  const ids = { session: await $.session.id(), tool_use_id: e.tool_use_id };
  const host = await gateHost($, st);
  const out = e.tool === 'Bash' ? await judgeBash(String(input.command ?? ''), ids, host) : await judgeFile(e.tool, input as FileInput, ids, host);
  if (safeId(e.tool_use_id)) {
    const path = `${await runDir($)}/verdicts/${e.tool_use_id}`;
    const match = matchFragment(e.tool, input);
    // the match first: answer.sh never finds a verdict without it
    if (match) await $.fs.write(`${path}.match`, match);
    await $.fs.write(path, verdictText(out.lines));
  }
  return out.log;
}

/** Refuses a subagent spawn whose answer is already in the conversation; undefined lets it run. */
async function agentGate($: Host, st: GuardState, input: { prompt?: string; subagent_type?: string; description?: string }): Promise<string | undefined> {
  const { cfg } = st;
  try {
    const k = await key($, st);
    if (!cfg.agentEnabled || !k || !input.prompt?.trim()) return undefined;
    const recent = recentTurns(turnsOf((await $.session.messages()) as Row[]), cfg.agentRecentTurns);
    if (!recent.length) return undefined;
    const t0 = Date.now();
    const res = await timed($, ask(hostFetch($), { apiKey: k, model: cfg.model, retries: 0 }, agentState(recent, input), AGENT_QUESTIONS), cfg.timeoutMs);
    const d = decideAgent(res, cfg.agentThreshold);
    await appendDecision($, { feature: 'agent', action: d.action, session: await $.session.id(), subagent: input.subagent_type, description: input.description, scores: d.scores, ms: Date.now() - t0 });
    return d.action === 'deny' ? d.reason : undefined;
  } catch (err) {
    await appendDecision($, { feature: 'agent', action: 'error', error: String(err) });
    return undefined;
  }
}

/**
 * Logs the calls jevgate let through as free that Claude Code's classifier judged
 * anyway (hooks/slips.sh finds them in the transcript): the free set is meant to
 * match Claude Code's own, so each one is a gap to close. Kept out of the UI.
 */
async function logSlips($: Host): Promise<void> {
  const session = await $.session.id();
  if (!/^[A-Za-z0-9_-]+$/.test(session)) return;
  const r = await $.process.run(['sh', `${$.plugin.root}/hooks/slips.sh`, `${await runDir($)}/pending/${session}`], { timeoutMs: 10000 });
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [id, tool] = line.split('\t');
    await appendDecision($, { feature: tool === 'Bash' ? 'bash' : 'file', action: 'slipped', session, tool_use_id: id });
  }
}

/** The done-check at a turn's end; true when it sent a follow-up and the model goes on. */
async function doneStep($: Host, st: GuardState, answer: string): Promise<boolean> {
  const { cfg } = st;
  const k = await key($, st);
  if (!cfg.doneEnabled || !k || !answer.trim()) return false;
  const session = await $.session.id().catch(() => undefined);
  try {
    const out = await doneCheck(
      { cfg, apiKey: k, run: hostRunner($), fetch: hostFetch($), cwd: await $.session.cwd(), timed: (p, ms) => timed($, p, ms) },
      { session, finalMessage: answer, rows: (await $.session.messages()) as Row[], request: st.request, blocks: st.followUps },
    );
    if (out.log) await appendDecision($, out.log);
    if (out.action === 'pass') {
      if (out.log?.action === 'cap-reached') {
        $.ui.toast(`jevgate: done-check sent ${st.followUps} follow-ups, letting it stop`, { timeoutMs: 8000 });
        st.followUps = 0;
      }
      return false;
    }
    st.followUps++;
    st.followUp = out.reason;
    // queued from a timer: the prompt starts its turn once this one has ended
    $.clock.after(1, () => $.prompt.submit({ text: out.reason }));
    return true;
  } catch (err) {
    await appendDecision($, { feature: 'done', action: 'error', session, error: String(err) });
    return false;
  }
}

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
    const label = footerLabel(tally(entries, session));
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
  /** Asked again only at this context percent after Not yet; 0 when not snoozed. */
  let snoozeUntil = 0;
  /** The answer given at the reminder, for the compaction it starts. */
  let chosen: CompactChoice | undefined;
  const ui: UiRuntime = { compactions: [], rowCache: new Map(), grouped: new Set(), footer: undefined };
  const compactions = ui.compactions;
  const rowCache = ui.rowCache;
  fullLog.on = cfg.log;
  const guard: GuardState = { cfg, apiKey: null, followUps: 0 };
  on('session.compact', async ($, e, next) => {
    if (!cfg.compactEnabled) return next(e);
    // At Claude Code's own limit (and its precompute for it) Claude Code compacts: jevgate asked at compactAtPercent.
    if (e.trigger === 'auto' || e.trigger === 'precompute') return next(e);
    const t0 = Date.now();
    const session = await $.session.id().catch(() => undefined);
    let choice = chosen;
    chosen = undefined;
    // `/compact <instructions>` is a request for a summary: only the summary can follow them
    if (e.trigger === 'manual' && e.instructions?.trim()) choice = 'summary';
    else if (e.trigger === 'manual') {
      choice = choiceOf(await $.ui.ask('Compact how?', { header: 'Compact', options: [TRIM, SUMMARY, CANCEL] }).catch(() => undefined));
      if (choice === 'none') {
        await appendDecision($, { feature: 'compact', action: 'cancelled', session, trigger: e.trigger });
        return { skip: 'jevgate: compaction cancelled' };
      }
    }
    if (choice === 'summary') {
      await appendDecision($, { feature: 'compact', action: 'summary', session, trigger: e.trigger, messages: e.messages.length, reason: e.instructions?.trim() ? 'instructions' : 'chosen' });
      return next(e);
    }

    const rank: Record<string, unknown> = {};
    const bail = async (why: string) => {
      await appendDecision($, { feature: 'compact', action: 'kept-as-is', session, trigger: e.trigger, messages: e.messages.length, reason: why, ...rank, ms: Date.now() - t0 });
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
          const ranked = fitBudget(messages, rankable(cands), cfg.compactTruncateHeadChars);
          const state = buildRankState(messages, ranked, cfg.compactTruncateHeadChars);
          const questions = rankQuestions(ranked);
          rank.jev_body_chars = JSON.stringify({ state, questions }).length;
          rank.ranked = ranked.length;
          const tJev = Date.now();
          // `$.http.fetch` takes no signal: the request runs on, but an abandoned compaction stops waiting for it
          const res = await Promise.race([ask(hostFetch($), { apiKey, model: cfg.model }, state, questions), abandoned(next.signal)]);
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
            'compact scores: ' +
              cands.map((c) => `${c.tool}:${(scores.get(c.id) ?? 0).toFixed(2)}${keep.has(c.id) ? '*' : ''}`).join(' '),
          );
        } catch (err) {
          // Jev is optional here: without it every candidate is truncated.
          rank.jev_error = err instanceof Error ? err.message : String(err);
          $.ui.log(`compact: Jev ranking skipped (${rank.jev_error})`);
        }
      }

      const out = apply(messages, truncate, cfg.compactTruncateHeadChars);
      const ratio = reductionRatio(messages, out);
      const ms = Date.now() - t0;
      const summary = `${truncate.size} truncated, ${restored} restored, ${Math.round(ratio * 100)}% smaller, ${ms}ms`;
      if (ratio < cfg.compactMinReductionRatio) return bail(`only ${summary}`);
      $.ui.toast(`jevgate: kept all ${out.length} messages, no summary (${summary})`, { timeoutMs: 8000 });
      await appendDecision($, {
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

  // `/clear` and a resume go on under another session id, with no session.start: drop what belonged to the old one
  on('session.end', async ($, e, next) => {
    snoozeUntil = 0;
    compactions.length = 0;
    guard.request = undefined;
    guard.followUps = 0;
    return next(e);
  });

  on('session.start', async ($, e, next) => {
    try {
      await runDir($);
    } catch (err) {
      runReady = undefined;
      $.ui.log(`handover dir not prepared (${err instanceof Error ? err.message : String(err)})`);
    }
    try {
      await $.command.register({ name: 'jevgate', description: 'jevgate guard tally: this session and all-time', immediate: true });
    } catch (err) {
      $.ui.log(`/jevgate not registered (${err instanceof Error ? err.message : String(err)})`);
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
        `${label}: free ${x.free} · allow ${x.allowed} · asked ${x.asked} (✓${x.approved} ✗${x.rejected}) · denied ${x.denied} · unreachable ${x.unreachable} · avg ${x.avgMs}ms`;
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
      ...lines.map((l) =>
        l.segments
          ? h(Text, { bold: l.bold, wrap: 'truncate-end' }, ...l.segments.map((g) => h(Text, { color: g.color, dimColor: g.dim }, g.text)))
          : l.dimHead
          ? h(Text, { color: l.color, bold: l.bold, wrap: 'truncate-end' }, h(Text, { dimColor: true }, l.text.slice(0, l.dimHead)), l.text.slice(l.dimHead))
          : h(Text, { color: l.color, dimColor: l.dim, bold: l.bold, wrap: 'truncate-end' }, l.text || ' '),
      ),
    );
  });

  // No event reaches this module when a command hook decides (the built-in sec-default runs
  // classic hooks without passing them on), and a done-check block keeps the turn going. So while
  // a main-loop turn runs (subagents raise no turn.start), look at the logs once a second and redraw when they changed.
  let ticker: { cancel: () => void } | undefined;
  let seen = '';
  on('turn.start', async ($, e, next) => {
    // a prompt the person typed starts a request; the done-check's own follow-ups continue one
    if (e.text.trim() && e.text !== guard.followUp) {
      guard.request = e.text;
      guard.followUps = 0;
    }
    if (!ticker) {
      ticker = $.clock.every(1000, () => {
        void (async () => {
          try {
            const stamp = (await Promise.all((await logFiles($)).map(async (p) => ((await $.fs.exists(p)) ? (await $.fs.stat(p)).mtimeMs : 0)))).join(',');
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

  // The guards: judged here, answered by answer.sh in Claude Code's permission step (see gate).
  // Once the call settles its entry is logged: tick the footer then, on a timer, so the model
  // gets the tool's result without waiting on the logs.
  on('tool.call', { tool: GUARDED_TOOL }, async ($, e, next) => {
    let logged: Promise<void> | undefined;
    try {
      const entry = await gate($, guard, e);
      if (entry) logged = appendDecision($, entry);
    } catch (err) {
      $.ui.log(`guard failed, answer.sh decides (${err instanceof Error ? err.message : String(err)})`);
    }
    const result = await next(e);
    $.clock.after(1, async () => {
      try {
        await logged;
        await refresh($, ui);
        // an asked call settles once you answered the prompt
        const answer = rowCache.get(e.tool_use_id)?.startsWith('? ') ? askAnswer(result) : undefined;
        if (answer) {
          const session = await $.session.id();
          await appendDecision($, { feature: e.tool === 'Bash' ? 'bash' : 'file', action: answer, session, tool_use_id: e.tool_use_id });
          await refresh($, ui);
        }
      } catch {
        // decoration
      }
    });
    return result;
  });


  // The subagent guard: refuse a spawn whose answer is already in the conversation.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const refused = await agentGate($, guard, e as unknown as { prompt?: string; subagent_type?: string; description?: string });
    return refused ? { deny: refused } : next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      ticker?.cancel();
      ticker = undefined;
    }
    // on a timer: the transcript holds this turn's results once the turn has ended
    $.clock.after(1, async () => {
      try {
        await logSlips($);
      } catch (err) {
        $.ui.log(`slips not checked (${err instanceof Error ? err.message : String(err)})`);
      }
    });
    // the main agent's answer only; a follow-up means the model goes on, so no reminder now
    if (!e.agentId && e.reason === 'answer' && (await doneStep($, guard, e.answer))) {
      await refresh($, ui);
      return next(e);
    }
    await refresh($, ui);
    // only between the main agent's turns: a subagent's turn ends inside the main one
    if (!cfg.compactEnabled || compacting || e.agentId) return next(e);
    try {
      const { context } = await $.session.usage();
      const pct = context.percent ?? 0;
      if (pct < cfg.compactAtPercent) snoozeUntil = 0;
      else if (pct >= snoozeUntil) {
        compacting = true;
        const c = choiceOf(
          await $.ui.ask(`Context is ${Math.round(pct)}% full. Compact now?`, { header: 'Compact', options: [TRIM, SUMMARY, LATER] }).catch(() => undefined),
        );
        // asked once per 10% step: a trim that frees too little does not ask again next turn
        snoozeUntil = snoozeTo(pct);
        if (c === 'none') {
          const session = await $.session.id().catch(() => undefined);
          await appendDecision($, { feature: 'compact', action: 'snoozed', session, trigger: 'plugin', percent: Math.round(pct), until: snoozeUntil });
          $.ui.toast(`jevgate: asking again at ${snoozeUntil}%`, { timeoutMs: 6000 });
        } else {
          chosen = c;
          await $.session.compact();
          chosen = undefined;
        }
      }
    } catch (err) {
      $.ui.log(`early compact skipped (${err instanceof Error ? err.message : String(err)})`);
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
