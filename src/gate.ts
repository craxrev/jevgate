// The Bash and file guards as the module runs them: pure over what the host
// hands in (git, Jev, the file system, the conversation), so tests fake it all.
// The outcome is a verdict per permission mode, which answer.sh applies.
import { ask, JevBlockedError, blockedFields, type FetchLike } from './jev.ts';
import { checkFree } from './free.ts';
import { gatherState, type Runner } from './bash-context.ts';
import { recentTurns, type Turn } from './transcript.ts';
import { BLOCKED_REASON, UNREACHABLE_REASON } from './bash-policy.ts';
import { BASH_FACTS, BASH_QUESTIONS, FILE_FACTS, FILE_QUESTIONS, DEFAULT_RULES, decideFacts, mergeRules, rawScores, resolveFacts, type Fact, type Facts } from './facts.ts';
import { WRITE_TOOLS, contentHead, isSensitivePath, resolvePath, toolPath, SECRET_READ_REASON, type FileInput, type FileState } from './file-policy.ts';
import { inScope, outsidePath, type Scope } from './scope.ts';
import { knownHosts, thresholds, type Config } from './config.ts';
import type { Decision } from './log.ts';
import type { VerdictLine } from './verdict.ts';
import type { Questions } from './jev.ts';

export type GateHost = {
  cfg: Config;
  apiKey?: string;
  run: Runner;
  fetch: FetchLike;
  exists: (path: string) => Promise<boolean>;
  /** The rules file's JSON, or undefined when none is set or it cannot be read. */
  rulesFile: () => Promise<unknown>;
  turns: () => Promise<Turn[]>;
  /** The shell's folder now. */
  cwd: string;
  /** Where the session started, and the added directories: see scope.ts. */
  roots: readonly string[];
  home?: string;
  /** `p`, or a rejection once `ms` passed. */
  timed: <T>(p: Promise<T>, ms: number) => Promise<T>;
  /** No call to Jev has gone out on this load yet: this one opens the connection. */
  cold?: boolean;
};

/** The verdict lines for answer.sh, and the log entry (absent when nothing is logged). */
export type GateOutcome = { lines: VerdictLine[]; log?: Decision };

const NO_KEY_REASON = 'jevgate: no TYPESAFE_API_KEY, refusing to run unguarded. Set the key in settings env or turn the guard off.';

const only = (kind: VerdictLine['kind'], reason = ''): VerdictLine[] => [{ mode: '*', kind, reason }];

type Ids = { session?: string; tool_use_id: string };

const scopeOf = (host: GateHost, ids: Ids): Scope => ({ cwd: host.cwd, roots: host.roots, session: ids.session, home: host.home });

/** Facts to verdict lines: `*` from the rules file's base rules, one more line for each mode it overrides. */
function decided(facts: Facts, rulesFile: unknown, cfg: Config) {
  const base = decideFacts(facts, mergeRules(DEFAULT_RULES, rulesFile, undefined), cfg.unsureOutcome);
  const lines: VerdictLine[] = [{ mode: '*', kind: base.action, reason: base.reason }];
  const modes = (rulesFile as { modes?: Record<string, unknown> } | undefined)?.modes;
  for (const mode of modes && typeof modes === 'object' ? Object.keys(modes) : []) {
    const d = decideFacts(facts, mergeRules(DEFAULT_RULES, rulesFile, mode), cfg.unsureOutcome);
    lines.push({ mode, kind: d.action, reason: d.reason });
  }
  return { base, lines };
}

async function judge(
  host: GateHost,
  entry: Decision,
  state: unknown,
  questions: Questions,
  facts: readonly Fact[],
  t0: number,
  prepMs: number,
): Promise<GateOutcome> {
  const { cfg } = host;
  // Jev's own time, from its gateway; the rest of the wait is the network (and, cold, connecting)
  let serverMs: number | undefined;
  const fetch: FetchLike = async (url, init) => {
    const r = await host.fetch(url, init);
    const v = Number(r.headers?.['x-envoy-upstream-service-time']);
    if (r.headers?.['x-envoy-upstream-service-time'] !== undefined && Number.isFinite(v)) serverMs = v;
    return r;
  };
  const cold = host.cold ? { cold: true } : {};
  try {
    const res = await host.timed(ask(fetch, { apiKey: host.apiKey!, model: cfg.model, retries: 0 }, state, questions), cfg.timeoutMs);
    const rulesFile = await host.rulesFile();
    const { base, lines } = decided(resolveFacts(res, facts, thresholds(cfg)), rulesFile, cfg);
    const timing = { prepMs, ms: Date.now() - t0, ...(serverMs !== undefined ? { serverMs } : {}), ...cold };
    const logged = { ...entry, facts: base.facts, scores: rawScores(res, facts), ...timing };
    const action = base.action === 'allow' ? 'allow' : base.action === 'ask' ? 'asked' : 'denied';
    return { lines, log: { ...logged, action, ...(base.action === 'allow' ? {} : { category: base.flags.join(', '), reason: base.reason }) } };
  } catch (err) {
    const blocked = err instanceof JevBlockedError;
    const log = { ...entry, action: 'unreachable', ...(blocked ? { category: 'blocked' } : {}), error: String(err), ...blockedFields(err), prepMs, ms: Date.now() - t0, ...cold };
    return { lines: blocked ? only('blocked', BLOCKED_REASON) : only('unreachable', UNREACHABLE_REASON), log };
  }
}

export async function judgeBash(command: string, ids: Ids, host: GateHost): Promise<GateOutcome> {
  const { cfg } = host;
  if (!cfg.bashEnabled || !command.trim()) return { lines: only('free') };
  const entry: Decision = { feature: 'bash', session: ids.session, tool_use_id: ids.tool_use_id, command, action: '' };
  const free = checkFree(command);
  // read-only, and where Claude Code lets it through too: else its classifier would judge it
  if (free.free && outsidePath(free.parsed, scopeOf(host, ids)) === undefined) return { lines: only('free'), log: { ...entry, action: 'free' } };
  if (!host.apiKey) return { lines: only('nokey', NO_KEY_REASON), log: { ...entry, action: 'denied', reason: 'no api key' } };
  const t0 = Date.now();
  const state = await gatherState(
    { command, parsed: free.parsed, cwd: host.cwd, turns: await host.turns(), recentTurns: cfg.bashRecentTurns, home: host.home, knownHosts: knownHosts(cfg) },
    host.run,
  );
  return judge(host, entry, state, BASH_QUESTIONS, BASH_FACTS, t0, Date.now() - t0);
}

export async function judgeFile(tool: string, input: FileInput, ids: Ids, host: GateHost): Promise<GateOutcome> {
  const { cfg } = host;
  const raw = toolPath(input);
  if (!cfg.fileEnabled || !raw) return { lines: only('free') };
  const path = resolvePath(raw, host.cwd, host.home);
  const entry: Decision = { feature: 'file', session: ids.session, tool_use_id: ids.tool_use_id, tool, path, action: '' };
  if (!WRITE_TOOLS.has(tool)) {
    // Read and anything else: only secret paths matter, and they need no model
    if (isSensitivePath(path)) return { lines: only('deny', SECRET_READ_REASON), log: { ...entry, action: 'denied', category: 'exposes_secret', reason: SECRET_READ_REASON } };
    return { lines: only('free') };
  }
  const repoRoot = (await host.run('git', ['rev-parse', '--show-toplevel'], host.cwd))?.trim() || undefined;
  if (inScope(path, scopeOf(host, ids))) return { lines: only('free'), log: { ...entry, action: 'free' } };
  if (!host.apiKey) return { lines: only('nokey', 'jevgate: no TYPESAFE_API_KEY, refusing to write outside the project unguarded.'), log: { ...entry, action: 'denied', reason: 'no api key' } };
  const t0 = Date.now();
  const [exists, turns] = await Promise.all([host.exists(path), host.turns()]);
  const state: FileState = { command: `${tool} ${path}`, tool, path, cwd: host.cwd, repo_root: repoRoot, exists, home: host.home };
  const head = contentHead(input);
  if (head) state.content_head = head;
  const recent = recentTurns(turns, cfg.bashRecentTurns, 1500);
  if (recent.length) state.recent = recent;
  return judge(host, entry, state, FILE_QUESTIONS, FILE_FACTS, t0, Date.now() - t0);
}
