// PreToolUse(Bash): the guard. Commands in Claude Code's own read-only free set
// run without a word. Everything else gets one Jev call that reports facts
// (what the command deletes, ships, changes, uploads, prints); the outcome
// comes from the rules in facts.ts: allow (in auto mode that skips the
// classifier), ask (a real prompt, in bypass mode too) or deny. Jev unreachable
// is a deny in bypass mode, where nothing else would judge, and silent
// elsewhere; a request its gateway blocks is an ask.
import { readStdinJson, emit } from '../src/stdin.ts';
import { fromEnv, defaultLogPath, thresholds, rules, knownHosts } from '../src/config.ts';
import { ask, nodeFetch, JevBlockedError } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { checkFree } from '../src/free.ts';
import { gatherState } from '../src/bash-context.ts';
import { denyOutput, allowOutput, askOutput, failsClosed, UNREACHABLE_REASON, BLOCKED_REASON } from '../src/bash-policy.ts';
import { BASH_FACTS, BASH_QUESTIONS, resolveFacts, decideFacts, rawScores } from '../src/facts.ts';

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
    recentTurns: cfg.bashRecentTurns,
    home: process.env.HOME,
    knownHosts: knownHosts(cfg),
  });
  try {
    const res = await ask(nodeFetch(cfg.timeoutMs), { apiKey: cfg.apiKey, model: cfg.model }, state, BASH_QUESTIONS);
    const d = decideFacts(resolveFacts(res, BASH_FACTS, thresholds(cfg)), rules(cfg, mode), cfg.unsureOutcome);
    const entry = { ...base, facts: d.facts, scores: rawScores(res, BASH_FACTS), ms: Date.now() - t0 };
    if (d.action === 'deny') {
      appendLog(logPath, { ...entry, action: 'denied', category: d.hits.join(', '), reason: d.reason });
      emit(denyOutput(d.reason));
    } else if (d.action === 'ask') {
      appendLog(logPath, { ...entry, action: 'asked', category: d.hits.join(', '), reason: d.reason });
      emit(askOutput(d.reason));
    } else {
      appendLog(logPath, { ...entry, action: 'allow' });
      emit(allowOutput(d.reason));
    }
  } catch (err) {
    if (err instanceof JevBlockedError) {
      appendLog(logPath, { ...base, action: 'asked', category: 'blocked', reason: BLOCKED_REASON, error: String(err), ms: Date.now() - t0 });
      emit(askOutput(BLOCKED_REASON));
      return;
    }
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
