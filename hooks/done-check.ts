// Stop: before Claude hands back, ask Jev whether the diff covers the request
// and the final message is honest. Block with the reason, at most N times.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readStdinJson, emit } from '../src/stdin.ts';
import { fromEnv, defaultLogPath } from '../src/config.ts';
import { ask, nodeFetch } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { readTranscript, latestUserPrompt, firstUserPrompt } from '../src/transcript.ts';
import { QUESTIONS, decide, blockOutput, nextCounter, type Counter, type DoneState } from '../src/done-policy.ts';

type Input = {
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
};

const cfg = fromEnv(process.env);
const logPath = cfg.logPath ?? defaultLogPath(process.env);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
}

const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$|\.(min\.js|min\.css|map|snap|d\.ts|lock|svg|png|jpe?g|gif|ico|pdf|woff2?)$/;

/** Per-file budget: share the overall cap across files, between 1.5k and 8k chars each. */
function perFileCap(files: number, maxChars: number): number {
  return Math.max(1500, Math.min(8000, Math.floor(maxChars / Math.max(1, files))));
}

function capFile(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + `\n[file diff truncated, ${text.length} chars]\n` : text;
}

function untrackedDiff(cwd: string, f: string): string {
  try {
    return git(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', f]);
  } catch (e) {
    // exits 1 when files differ; the diff is on stdout
    const out = (e as { stdout?: string }).stdout;
    return typeof out === 'string' ? out : '';
  }
}

/**
 * Working tree vs HEAD plus new untracked files. Capped per file so one
 * generated or vendored file cannot crowd out the real change, and capped overall.
 */
function collectDiff(cwd: string, maxChars: number): { diff: string; truncated: boolean } | undefined {
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return undefined;
  }
  const hasHead = (() => {
    try {
      git(cwd, ['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  })();
  const tracked = hasHead
    ? git(cwd, ['diff', 'HEAD', '--name-only', '--no-color']).split('\n').filter(Boolean)
    : [];
  let untracked: string[] = [];
  try {
    untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).slice(0, 60);
  } catch {
    // best-effort
  }
  const keep = (f: string) => !SKIP_FILES.test(f);
  const skipped = tracked.length + untracked.length - tracked.filter(keep).length - untracked.filter(keep).length;
  const cap = perFileCap(tracked.filter(keep).length + untracked.filter(keep).length, maxChars);

  const parts: string[] = [];
  for (const f of tracked.filter(keep)) {
    parts.push(capFile(git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', f]), cap));
  }
  for (const f of untracked.filter(keep)) {
    parts.push(capFile(untrackedDiff(cwd, f), cap));
  }

  let diff = parts.join('');
  if (skipped > 0) diff += `\n[${skipped} generated/lock/binary file(s) omitted]\n`;
  if (!diff.trim()) return undefined;
  const truncated = diff.length > maxChars;
  return { diff: truncated ? diff.slice(0, maxChars) + '\n[diff truncated]' : diff, truncated };
}

function counterPath(sessionId: string): string {
  return `${dirname(logPath)}/state/${sessionId}.json`;
}

function readCounter(sessionId: string): Counter | undefined {
  try {
    return JSON.parse(readFileSync(counterPath(sessionId), 'utf8')) as Counter;
  } catch {
    return undefined;
  }
}

function writeCounter(sessionId: string, c: Counter): void {
  try {
    const p = counterPath(sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(c));
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  if (!cfg.doneEnabled || !cfg.apiKey) return;
  const input = await readStdinJson<Input>();
  const session = input.session_id ?? 'unknown';
  const finalMessage = (input.last_assistant_message ?? '').trim();
  if (!finalMessage) return;

  const counter = nextCounter(readCounter(session), input.stop_hook_active === true);
  if (counter.blocks >= cfg.doneMaxBlocks) {
    appendLog(logPath, { feature: 'done', action: 'cap-reached', session, blocks: counter.blocks });
    writeCounter(session, { blocks: 0 });
    emit({ systemMessage: `jevgate: done-check blocked ${counter.blocks}x, letting through.` });
    return;
  }

  const cwd = input.cwd ?? process.cwd();
  const collected = collectDiff(cwd, cfg.doneDiffMaxChars);
  if (!collected) {
    appendLog(logPath, { feature: 'done', action: 'skip-no-diff', session });
    writeCounter(session, counter);
    return;
  }

  const turns = readTranscript(input.transcript_path);
  const state: DoneState = {
    request_first: firstUserPrompt(turns),
    request_latest: latestUserPrompt(turns, input.prompt_id),
    final_message: finalMessage,
    diff: collected.diff,
    diff_truncated: collected.truncated,
  };
  if (!state.request_latest) {
    appendLog(logPath, { feature: 'done', action: 'skip-no-request', session });
    return;
  }

  const t0 = Date.now();
  const res = await ask(nodeFetch(Math.max(cfg.timeoutMs, 8000)), { apiKey: cfg.apiKey, model: cfg.model }, state, QUESTIONS);
  const d = decide(res, { coverMin: cfg.doneCoverMin, claimsMin: cfg.doneClaimsMin, leftoverMax: cfg.doneLeftoverMax });
  appendLog(logPath, {
    feature: 'done',
    action: d.action,
    session,
    scores: d.scores,
    blocks: counter.blocks,
    diffChars: collected.diff.length,
    ms: Date.now() - t0,
  });
  if (d.action === 'block') {
    writeCounter(session, { blocks: counter.blocks + 1 });
    emit(blockOutput(d.reason));
  } else {
    writeCounter(session, { blocks: 0 });
  }
}

main().catch((err: unknown) => {
  appendLog(logPath, { feature: 'done', action: 'error', error: String(err) });
});
