// PreToolUse(Bash): the guard. Commands in Claude Code's own read-only free set
// run without a word. Everything else is judged once by Jev against the harm
// categories: a category over its threshold is a deny; every category under the
// allow ceiling is an allow (in auto mode that skips the classifier); in between
// the hook stays silent and Claude Code decides. Jev unreachable is a deny in
// bypass mode, where nothing else would judge, and silent elsewhere.
import { readStdinJson, emit } from '../src/stdin.ts';
import { fromEnv, defaultLogPath, bashThresholds } from '../src/config.ts';
import { ask, nodeFetch } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { checkFree } from '../src/free.ts';
import { gatherState } from '../src/bash-context.ts';
import { QUESTIONS, decide, denyOutput, allowOutput, topScores, failsClosed, UNREACHABLE_REASON } from '../src/bash-policy.ts';

type Input = {
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string; description?: string };
};

const cfg = fromEnv(process.env);
const logPath = cfg.logPath ?? defaultLogPath(process.env);

const NO_KEY_REASON =
  'jevgate: no TYPESAFE_API_KEY, refusing to run unguarded. Set the key in settings env or turn the bash guard off.';

async function main(): Promise<void> {
  if (!cfg.bashEnabled) return;
  const input = await readStdinJson<Input>();
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return;
  const mode = input.permission_mode;
  const base = { feature: 'bash' as const, session: input.session_id, tool_use_id: input.tool_use_id, command, mode };

  const free = checkFree(command);
  if (free.free) {
    appendLog(logPath, { ...base, action: 'free' });
    return;
  }
  if (!cfg.apiKey) {
    if (!failsClosed(mode)) return;
    appendLog(logPath, { ...base, action: 'denied', reason: 'no api key' });
    emit(denyOutput(NO_KEY_REASON));
    return;
  }

  const t0 = Date.now();
  const state = gatherState({
    command,
    parsed: free.parsed,
    cwd: input.cwd,
    transcriptPath: input.transcript_path,
    recentMessages: cfg.bashRecentMessages,
  });
  try {
    const res = await ask(nodeFetch(cfg.timeoutMs), { apiKey: cfg.apiKey, model: cfg.model }, state, QUESTIONS);
    const d = decide(res, bashThresholds(cfg), cfg.bashAllowMax);
    const ms = Date.now() - t0;
    if (d.action === 'deny') {
      appendLog(logPath, { ...base, action: 'denied', category: d.category, reason: d.reason, scores: d.scores, ms });
      emit(denyOutput(d.reason));
      return;
    }
    appendLog(logPath, { ...base, action: d.action, scores: d.scores, top: topScores(d.scores), ms });
    if (d.action === 'allow') emit(allowOutput(d.reason));
  } catch (err) {
    // Bypass mode has no review behind this hook, so nothing unjudged runs there.
    // Elsewhere Claude Code's own flow (rules, classifier, prompts) takes over.
    const closed = failsClosed(mode);
    appendLog(logPath, { ...base, action: 'unreachable', closed, error: String(err), ms: Date.now() - t0 });
    if (closed) emit(denyOutput(UNREACHABLE_REASON));
  }
}

main().catch((err: unknown) => {
  // Even a bug in the hook must not let a command through unjudged.
  appendLog(logPath, { feature: 'bash', action: 'error', error: String(err) });
  emit(denyOutput(`jevgate: hook error, refusing to run unguarded (${err instanceof Error ? err.message : String(err)})`));
});
