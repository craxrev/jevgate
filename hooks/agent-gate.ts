// PreToolUse(Agent): deny a subagent spawn when the answer is already in the
// recent conversation. Silent otherwise.
import { readStdinJson, emit } from '../src/stdin.ts';
import { fromEnv, defaultLogPath } from '../src/config.ts';
import { ask, nodeFetch } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { readTranscript, recentTurns } from '../src/transcript.ts';
import { buildState, QUESTIONS, decide, denyOutput } from '../src/agent-policy.ts';

type Input = {
  session_id?: string;
  transcript_path?: string;
  tool_input?: { subagent_type?: string; description?: string; prompt?: string };
};

const cfg = fromEnv(process.env);
const logPath = cfg.logPath ?? defaultLogPath(process.env);

async function main(): Promise<void> {
  if (!cfg.agentEnabled || !cfg.apiKey) return;
  const input = await readStdinJson<Input>();
  const prompt = input.tool_input?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return;

  const recent = recentTurns(readTranscript(input.transcript_path), cfg.agentRecentTurns);
  if (recent.length === 0) return;

  const t0 = Date.now();
  const res = await ask(
    nodeFetch(cfg.timeoutMs),
    { apiKey: cfg.apiKey, model: cfg.model },
    buildState(recent, input.tool_input ?? {}),
    QUESTIONS,
  );
  const d = decide(res, cfg.agentThreshold);
  appendLog(logPath, {
    feature: 'agent',
    action: d.action,
    session: input.session_id,
    subagent: input.tool_input?.subagent_type,
    description: input.tool_input?.description,
    scores: d.scores,
    ms: Date.now() - t0,
  });
  if (d.action === 'deny') emit(denyOutput(d.reason));
}

main().catch((err: unknown) => {
  appendLog(logPath, { feature: 'agent', action: 'error', error: String(err) });
});
