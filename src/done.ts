// The done-check as the module runs it, at turn.complete: before Claude hands
// back, is the diff what was asked for and is the final message honest? The
// verdict is a follow-up prompt the module sends (a function hook cannot block
// a stop), at most `doneMaxBlocks` in a row.
import { ask, type FetchLike } from './jev.ts';
import type { Runner } from './bash-context.ts';
import { QUESTIONS, decide, turnChangedFiles, type DoneState } from './done-policy.ts';
import { firstUserPrompt, turnToolUses, turnsOf, type Row } from './transcript.ts';
import type { Config } from './config.ts';
import type { Decision } from './log.ts';

const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$|\.(min\.js|min\.css|map|snap|d\.ts|lock|svg|png|jpe?g|gif|ico|pdf|woff2?)$/;

/** Per-file budget: share the overall cap across files, between 1.5k and 8k chars each. */
function perFileCap(files: number, maxChars: number): number {
  return Math.max(1500, Math.min(8000, Math.floor(maxChars / Math.max(1, files))));
}

function capFile(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + `\n[file diff truncated, ${text.length} chars]\n` : text;
}

/**
 * Working tree vs HEAD plus new untracked files. Capped per file so one
 * generated or vendored file cannot crowd out the real change, and capped overall.
 */
export async function collectDiff(run: Runner, cwd: string, maxChars: number): Promise<{ diff: string; truncated: boolean } | undefined> {
  const git = (...args: string[]) => Promise.resolve(run('git', args, cwd));
  if ((await git('rev-parse', '--is-inside-work-tree')) === undefined) return undefined;
  const [head, untrackedOut] = await Promise.all([git('rev-parse', '--verify', 'HEAD'), git('ls-files', '--others', '--exclude-standard')]);
  const tracked = head !== undefined ? ((await git('diff', 'HEAD', '--name-only', '--no-color')) ?? '').split('\n').filter(Boolean) : [];
  const untracked = (untrackedOut ?? '').split('\n').filter(Boolean).slice(0, 60);
  const keep = (f: string) => !SKIP_FILES.test(f);
  const [t, u] = [tracked.filter(keep), untracked.filter(keep)];
  const skipped = tracked.length + untracked.length - t.length - u.length;
  const cap = perFileCap(t.length + u.length, maxChars);
  const parts = await Promise.all([
    ...t.map((f) => git('diff', 'HEAD', '--no-color', '--no-ext-diff', '--', f)),
    // exits 1 when the files differ; the diff is on stdout
    ...u.map((f) => Promise.resolve(run('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', f], cwd, { anyExit: true }))),
  ]);
  let diff = parts.map((p) => capFile(p ?? '', cap)).join('');
  if (skipped > 0) diff += `\n[${skipped} generated/lock/binary file(s) omitted]\n`;
  if (!diff.trim()) return undefined;
  const truncated = diff.length > maxChars;
  return { diff: truncated ? diff.slice(0, maxChars) + '\n[diff truncated]' : diff, truncated };
}

export type DoneHost = {
  cfg: Config;
  apiKey?: string;
  run: Runner;
  fetch: FetchLike;
  cwd: string;
  /** `p`, or a rejection once `ms` passed. */
  timed: <T>(p: Promise<T>, ms: number) => Promise<T>;
};

export type DoneInput = {
  session?: string;
  /** The assistant's final text this turn. */
  finalMessage: string;
  rows: readonly Row[];
  /** What the person asked, kept across the module's own follow-ups (which are the latest prompt then). */
  request: string | undefined;
  /** Follow-ups sent for this request so far. */
  blocks: number;
};

/** `block` carries the follow-up to send; everything else lets the turn end. */
export type DoneOutcome = { action: 'block'; reason: string; log: Decision } | { action: 'pass'; log?: Decision };

export async function doneCheck(host: DoneHost, input: DoneInput): Promise<DoneOutcome> {
  const { cfg } = host;
  const base = { feature: 'done' as const, session: input.session };
  if (input.blocks >= cfg.doneMaxBlocks) return { action: 'pass', log: { ...base, action: 'cap-reached', blocks: input.blocks } };
  if (!turnChangedFiles(turnToolUses(input.rows))) return { action: 'pass', log: { ...base, action: 'skip-no-change' } };
  const collected = await collectDiff(host.run, host.cwd, cfg.doneDiffMaxChars);
  if (!collected) return { action: 'pass', log: { ...base, action: 'skip-no-diff' } };
  if (!input.request) return { action: 'pass', log: { ...base, action: 'skip-no-request' } };
  const state: DoneState = {
    request_first: firstUserPrompt(turnsOf(input.rows)),
    request_latest: input.request,
    final_message: input.finalMessage,
    diff: collected.diff,
    diff_truncated: collected.truncated,
  };
  const t0 = Date.now();
  // a whole diff takes Jev longer than a command; 8s stays inside turn.complete's 10s budget
  const res = await host.timed(ask(host.fetch, { apiKey: host.apiKey!, model: cfg.model, retries: 0 }, state, QUESTIONS), 8000);
  const d = decide(res, { coverMin: cfg.doneCoverMin, claimsMin: cfg.doneClaimsMin, leftoverMax: cfg.doneLeftoverMax });
  const log: Decision = { ...base, action: d.action, scores: d.scores, blocks: input.blocks, diffChars: collected.diff.length, ms: Date.now() - t0 };
  return d.action === 'block' ? { action: 'block', reason: d.reason, log } : { action: 'pass', log };
}
