// PreToolUse(Edit|Write|MultiEdit|NotebookEdit|Read): the file guard. Inside
// the project (or the scratchpad) nothing is asked. A read of a path that
// holds credentials is refused locally. A write outside the project gets one
// Jev call with the file facts (does it replace data, change the system, was
// it asked for) and the same rules as the Bash guard, so a change cannot
// route around the stricter tool. Jev unreachable: deny in bypass mode,
// silent elsewhere; a request its gateway blocks is an ask.
import { readStdinJson, emit } from '../src/stdin.ts';
import { existsSync } from 'node:fs';
import { fromEnv, defaultLogPath, thresholds } from '../src/config.ts';
import { rules } from '../src/rules-file.ts';
import { ask, nodeFetch, JevBlockedError } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { execRunner, recentTurns } from '../src/bash-context.ts';
import { denyOutput, askOutput, allowOutput, failsClosed, UNREACHABLE_REASON, BLOCKED_REASON } from '../src/bash-policy.ts';
import { FILE_FACTS, FILE_QUESTIONS, resolveFacts, decideFacts, rawScores } from '../src/facts.ts';
import {
  WRITE_TOOLS,
  toolPath,
  contentHead,
  resolvePath,
  insideProject,
  isSensitivePath,
  SECRET_READ_REASON,
  type FileInput,
  type FileState,
} from '../src/file-policy.ts';

type Input = {
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: FileInput;
};

const cfg = fromEnv(process.env);
const logPath = cfg.logPath ?? defaultLogPath(process.env);

async function main(): Promise<void> {
  if (!cfg.fileEnabled) return;
  const input = await readStdinJson<Input>();
  const tool = input.tool_name ?? '';
  const raw = toolPath(input.tool_input);
  if (!raw) return;
  const path = resolvePath(raw, input.cwd, process.env.HOME);
  const mode = input.permission_mode;
  const base = { feature: 'file' as const, session: input.session_id, tool_use_id: input.tool_use_id, tool, path, mode };

  if (!WRITE_TOOLS.has(tool)) {
    // Read and anything else: only secret paths matter, and they need no model.
    if (isSensitivePath(path)) {
      appendLog(logPath, { ...base, action: 'denied', category: 'exposes_secret', reason: SECRET_READ_REASON });
      emit(denyOutput(SECRET_READ_REASON));
    }
    return;
  }

  const repoRoot = execRunner('git', ['rev-parse', '--show-toplevel'], input.cwd)?.trim() || undefined;
  if (insideProject(path, repoRoot, input.cwd)) {
    appendLog(logPath, { ...base, action: 'free' });
    return;
  }
  if (!cfg.apiKey) {
    if (!failsClosed(mode)) return;
    appendLog(logPath, { ...base, action: 'denied', reason: 'no api key' });
    emit(denyOutput('jevgate: no TYPESAFE_API_KEY, refusing to write outside the project unguarded.'));
    return;
  }

  const t0 = Date.now();
  const state: FileState = { command: `${tool} ${path}`, tool, path, cwd: input.cwd, repo_root: repoRoot, exists: existsSync(path), home: process.env.HOME };
  const head = contentHead(input.tool_input);
  if (head) state.content_head = head;
  const recent = recentTurns(input.transcript_path, cfg.bashRecentTurns);
  if (recent) state.recent = recent;
  try {
    const res = await ask(nodeFetch(cfg.timeoutMs), { apiKey: cfg.apiKey, model: cfg.model }, state, FILE_QUESTIONS);
    const d = decideFacts(resolveFacts(res, FILE_FACTS, thresholds(cfg)), rules(cfg, mode), cfg.unsureOutcome);
    const entry = { ...base, facts: d.facts, scores: rawScores(res, FILE_FACTS), ms: Date.now() - t0 };
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
    const closed = failsClosed(mode);
    appendLog(logPath, { ...base, action: 'unreachable', closed, error: String(err), ms: Date.now() - t0 });
    if (closed) emit(denyOutput(UNREACHABLE_REASON));
  }
}

main().catch((err: unknown) => {
  appendLog(logPath, { feature: 'file', action: 'error', error: String(err) });
  emit(denyOutput(`jevgate: hook error, refusing to write unguarded (${err instanceof Error ? err.message : String(err)})`));
});
