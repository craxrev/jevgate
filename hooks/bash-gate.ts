// PreToolUse(Bash): pre-approve obviously harmless commands so they skip the
// auto-mode classifier. Never denies. Silent on any doubt or error.
import { readStdinJson, emit } from '../src/stdin.ts';
import { fromEnv, defaultLogPath } from '../src/config.ts';
import { ask, nodeFetch } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { neverAskReason, buildState, QUESTIONS, decide, allowOutput } from '../src/bash-policy.ts';

type Input = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string; description?: string };
};

const cfg = fromEnv(process.env);
const logPath = cfg.logPath ?? defaultLogPath(process.env);

async function main(): Promise<void> {
  if (!cfg.bashEnabled || !cfg.apiKey) return;
  const input = await readStdinJson<Input>();
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return;

  const notAsked = neverAskReason(command);
  if (notAsked) {
    appendLog(logPath, { feature: 'bash', action: 'not-asked', reason: notAsked, session: input.session_id, tool_use_id: input.tool_use_id, command });
    return;
  }

  const t0 = Date.now();
  const res = await ask(
    nodeFetch(cfg.timeoutMs),
    { apiKey: cfg.apiKey, model: cfg.model },
    buildState({ command, description: input.tool_input?.description }, input.cwd),
    QUESTIONS,
  );
  const d = decide(res, { threshold: cfg.bashThreshold, devUnsafeMax: cfg.bashDevUnsafeMax });
  appendLog(logPath, {
    feature: 'bash',
    action: d.action,
    session: input.session_id,
    tool_use_id: input.tool_use_id,
    command,
    scores: d.scores,
    ms: Date.now() - t0,
  });
  if (d.action === 'fast-lane') emit(allowOutput(d.reason));
}

main().catch((err: unknown) => {
  appendLog(logPath, { feature: 'bash', action: 'error', error: String(err) });
  // stay silent: the normal permission flow takes over
});
