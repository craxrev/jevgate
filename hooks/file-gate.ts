// PreToolUse(Edit|Write|MultiEdit|NotebookEdit|Read): the file guard. Inside
// the project (or the scratchpad) nothing is asked. A read of a path that
// holds credentials is refused locally. A write outside the project gets one
// Jev call: does it change the system or the user's environment, and did the
// user ask for it. Jev unreachable: deny in bypass mode, silent elsewhere.
import { readStdinJson, emit } from '../src/stdin.ts';
import { fromEnv, defaultLogPath } from '../src/config.ts';
import { ask, nodeFetch } from '../src/jev.ts';
import { appendLog } from '../src/log.ts';
import { execRunner, recentTurns } from '../src/bash-context.ts';
import { denyOutput, failsClosed, UNREACHABLE_REASON } from '../src/bash-policy.ts';
import {
  WRITE_TOOLS,
  toolPath,
  contentHead,
  resolvePath,
  insideProject,
  isSensitivePath,
  FILE_QUESTIONS,
  decideFile,
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
      appendLog(logPath, { ...base, action: 'denied', category: 'reads_secrets', reason: SECRET_READ_REASON });
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
  const state: FileState = { tool, path, cwd: input.cwd, repo_root: repoRoot };
  const head = contentHead(input.tool_input);
  if (head) state.content_head = head;
  const recent = recentTurns(input.transcript_path, cfg.bashRecentTurns);
  if (recent) state.recent = recent;
  try {
    const res = await ask(nodeFetch(cfg.timeoutMs), { apiKey: cfg.apiKey, model: cfg.model }, state, FILE_QUESTIONS);
    const d = decideFile(res, { changes_system_or_user_config: cfg.fileDenySystem, exceeds_request: cfg.fileDenyExceeds });
    const ms = Date.now() - t0;
    if (d.action === 'deny') {
      appendLog(logPath, { ...base, action: 'denied', category: d.category, reason: d.reason, scores: d.scores, ms });
      emit(denyOutput(d.reason));
      return;
    }
    appendLog(logPath, { ...base, action: 'ok', scores: d.scores, ms });
  } catch (err) {
    const closed = failsClosed(mode);
    appendLog(logPath, { ...base, action: 'unreachable', closed, error: String(err), ms: Date.now() - t0 });
    if (closed) emit(denyOutput(UNREACHABLE_REASON));
  }
}

main().catch((err: unknown) => {
  appendLog(logPath, { feature: 'file', action: 'error', error: String(err) });
  emit(denyOutput(`jevgate: hook error, refusing to write unguarded (${err instanceof Error ? err.message : String(err)})`));
});
