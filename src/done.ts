// The done-check as the module runs it, at turn.complete: before Claude hands
// back, are the request's changes what was asked for and is the final message
// honest? The verdict is a follow-up prompt the module sends (a function hook
// cannot block a stop), at most `doneMaxBlocks` in a row.
import { ask, type FetchLike } from './jev.ts';
import type { Runner } from './bash-context.ts';
import { FOLLOW_UP_PREFIX, QUESTIONS, decide, turnChangedFiles, type DoneState } from './done-policy.ts';
import { recentTurns, turnToolUses, turnsOf, type Row, type ToolUse } from './transcript.ts';
import type { Config } from './config.ts';
import type { Decision } from './log.ts';

const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$|\.(min\.js|min\.css|map|snap|d\.ts|lock|svg|png|jpe?g|gif|ico|pdf|woff2?)$/;
const COMMANDS_MAX = 15;
const OUTPUT_TAIL = 500;

/** Per-file budget: share the overall cap across files, between 1.5k and 8k chars each. */
function perFileCap(files: number, maxChars: number): number {
  return Math.max(1500, Math.min(8000, Math.floor(maxChars / Math.max(1, files))));
}

function capFile(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + `\n[file diff truncated, ${text.length} chars]\n` : text;
}

function capTotal(diff: string, maxChars: number): { diff: string; truncated: boolean } | undefined {
  if (!diff.trim()) return undefined;
  const truncated = diff.length > maxChars;
  return { diff: truncated ? diff.slice(0, maxChars) + '\n[diff truncated]' : diff, truncated };
}

// A copy of the real index keeps git's stat cache, so only changed files are hashed;
// the real index and the working tree are never touched.
const SNAPSHOT = `set -e
git rev-parse --is-inside-work-tree >/dev/null 2>&1
idx=$(git rev-parse --git-path index)
trap 'rm -f "$1"' EXIT
rm -f "$1"
if [ -f "$idx" ]; then cp "$idx" "$1"; fi
GIT_INDEX_FILE="$1" git add -A
GIT_INDEX_FILE="$1" git write-tree`;

/**
 * The working tree, untracked files included, as a git tree hash, built in a
 * throwaway index at `indexPath`; undefined outside a repository.
 */
export async function snapshotTree(run: Runner, cwd: string, indexPath: string): Promise<string | undefined> {
  const out = (await run('sh', ['-c', SNAPSHOT, 'jevgate', indexPath], cwd))?.trim();
  return out && /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
}

/**
 * What changed between two snapshots. Capped per file so one generated or
 * vendored file cannot crowd out the real change, and capped overall.
 */
export async function treeDiff(run: Runner, cwd: string, from: string, to: string, maxChars: number): Promise<{ diff: string; truncated: boolean } | undefined> {
  const out = await run('git', ['diff', '--no-color', '--no-ext-diff', from, to], cwd);
  const files = (out ?? '').split(/(?=^diff --git )/m).filter((f) => f.startsWith('diff --git '));
  const kept = files.filter((f) => !SKIP_FILES.test(/^diff --git a\/.* b\/(.*)$/m.exec(f)?.[1] ?? ''));
  const cap = perFileCap(kept.length, maxChars);
  let diff = kept.map((f) => capFile(f, cap)).join('');
  if (kept.length < files.length) diff += `\n[${files.length - kept.length} generated/lock/binary file(s) omitted]\n`;
  return capTotal(diff, maxChars);
}

const lines = (text: unknown, mark: string) => (typeof text === 'string' ? text.split('\n').map((l) => mark + l).join('\n') + '\n' : '');

/** Outside git, or with no snapshot from the request's start: the edits as the file tools made them. */
export function toolEdits(uses: readonly ToolUse[], maxChars: number): { diff: string; truncated: boolean } | undefined {
  const parts: string[] = [];
  for (const u of uses) {
    const i = u.input;
    if (u.name === 'Edit') parts.push(`Edit ${i.file_path}\n${lines(i.old_string, '- ')}${lines(i.new_string, '+ ')}`);
    else if (u.name === 'MultiEdit' && Array.isArray(i.edits))
      parts.push(`MultiEdit ${i.file_path}\n` + (i.edits as Record<string, unknown>[]).map((e) => lines(e.old_string, '- ') + lines(e.new_string, '+ ')).join('...\n'));
    else if (u.name === 'Write') parts.push(`Write ${i.file_path}\n${lines(i.content, '+ ')}`);
    else if (u.name === 'NotebookEdit') parts.push(`NotebookEdit ${i.notebook_path}\n${lines(i.new_source, '+ ')}`);
  }
  if (!parts.length) return undefined;
  const cap = perFileCap(parts.length, maxChars);
  const note = "[no git snapshot: the edits as this request's file tools made them; edits made by Bash commands are only in `commands`]\n";
  return capTotal(note + parts.map((p) => capFile(p, cap)).join(''), maxChars);
}

function brief(u: ToolUse): string {
  const what = u.input.command ?? u.input.file_path ?? u.input.notebook_path ?? '';
  return `${u.name} ${String(what).slice(0, 120)}`.trim();
}

export type DoneHost = {
  cfg: Config;
  apiKey?: string;
  run: Runner;
  fetch: FetchLike;
  cwd: string;
  /** The throwaway index the end-of-turn snapshot is built in. */
  indexPath: string;
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
  /** The working tree's snapshot when the request started, when one was taken. */
  base?: string;
};

/** `block` carries the follow-up to send; everything else lets the turn end. */
export type DoneOutcome = { action: 'block'; reason: string; log: Decision } | { action: 'pass'; log?: Decision };

export async function doneCheck(host: DoneHost, input: DoneInput): Promise<DoneOutcome> {
  const { cfg } = host;
  const base = { feature: 'done' as const, session: input.session };
  if (input.blocks >= cfg.doneMaxBlocks) return { action: 'pass', log: { ...base, action: 'cap-reached', blocks: input.blocks } };
  const continues = (t: string) => t.startsWith(FOLLOW_UP_PREFIX);
  // since the request's prompt: the done-check's own follow-ups continue it
  const uses = turnToolUses(input.rows, continues);
  if (!turnChangedFiles(uses)) return { action: 'pass', log: { ...base, action: 'skip-no-change' } };
  if (!input.request) return { action: 'pass', log: { ...base, action: 'skip-no-request' } };
  const end = input.base ? await snapshotTree(host.run, host.cwd, host.indexPath) : undefined;
  const source = input.base && end ? 'git' : 'tools';
  const collected = input.base && end ? await treeDiff(host.run, host.cwd, input.base, end, cfg.doneDiffMaxChars) : toolEdits(uses, cfg.doneDiffMaxChars);
  if (!collected) return { action: 'pass', log: { ...base, action: 'skip-no-diff', source } };
  const final = input.finalMessage.trim();
  const turns = turnsOf(input.rows).filter((t) => !(t.role === 'user' && continues(t.text)));
  if (turns.at(-1)?.role === 'assistant' && turns.at(-1)!.text === final) turns.pop();
  const state: DoneState = {
    recent: recentTurns(turns, cfg.doneRecentTurns, 1500),
    request_latest: input.request,
    final_message: input.finalMessage,
    diff: collected.diff,
    diff_truncated: collected.truncated,
    commands: uses
      .filter((u) => u.name === 'Bash' && typeof u.input.command === 'string')
      .slice(-COMMANDS_MAX)
      .map((u) => ({ command: String(u.input.command).slice(0, 300), output_tail: (u.output ?? '').slice(-OUTPUT_TAIL) })),
  };
  const t0 = Date.now();
  // a whole diff takes Jev longer than a command; 8s stays inside turn.complete's 10s budget
  const res = await host.timed(ask(host.fetch, { apiKey: host.apiKey!, model: cfg.model, retries: 0 }, state, QUESTIONS), 8000);
  const d = decide(res, { coverMin: cfg.doneCoverMin, claimsMin: cfg.doneClaimsMin });
  const log: Decision = {
    ...base,
    action: d.action,
    scores: d.scores,
    blocks: input.blocks,
    source,
    diffChars: collected.diff.length,
    ms: Date.now() - t0,
    tools: uses.slice(-40).map(brief),
    // what Jev was sent, so a verdict can be replayed; only the full log (`log` on) keeps it
    state,
  };
  return d.action === 'block' ? { action: 'block', reason: d.reason, log } : { action: 'pass', log };
}
