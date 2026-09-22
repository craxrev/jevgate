// Deterministic context for the Bash guard: local git facts and the latest
// user messages. No model is involved; the hook passes in a command runner so
// tests can fake it.
import { execFileSync } from 'node:child_process';
import { readTranscript } from './transcript.ts';
import { needsGitStatus, type BashState } from './bash-policy.ts';
import type { Parsed } from './shell.ts';

/** Runs a program and returns stdout, or undefined on any failure. */
export type Runner = (program: string, args: string[], cwd: string | undefined) => string | undefined;

export const execRunner: Runner = (program, args, cwd) => {
  try {
    return execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

const STATUS_MAX_LINES = 200;
const RECENT_MAX_CHARS = 1500;

export type ContextInput = {
  command: string;
  parsed: Parsed;
  cwd?: string;
  transcriptPath?: string;
  recentMessages: number;
};

/** The last `n` human messages of the main conversation, oldest first, each truncated. */
export function recentUserMessages(transcriptPath: string | undefined, n: number): string[] | undefined {
  if (n <= 0) return undefined;
  const users = readTranscript(transcriptPath).filter((t) => t.role === 'user');
  if (users.length === 0) return undefined;
  return users.slice(-n).map((t) => (t.text.length > RECENT_MAX_CHARS ? t.text.slice(0, RECENT_MAX_CHARS) + ' […]' : t.text));
}

function trimStatus(out: string): string {
  const lines = out.split('\n').filter(Boolean);
  if (lines.length <= STATUS_MAX_LINES) return lines.join('\n');
  return lines.slice(0, STATUS_MAX_LINES).join('\n') + `\n… ${lines.length - STATUS_MAX_LINES} more`;
}

export function gatherState(input: ContextInput, run: Runner = execRunner): BashState {
  const state: BashState = { command: input.command, cwd: input.cwd };
  const root = run('git', ['rev-parse', '--show-toplevel'], input.cwd)?.trim();
  if (root) {
    state.repo_root = root;
    const remotes = run('git', ['remote', '-v'], input.cwd)?.trim();
    if (remotes !== undefined) state.remotes = remotes;
    if (needsGitStatus(input.parsed)) {
      const status = run('git', ['status', '--porcelain'], input.cwd);
      if (status !== undefined) state.git_status = trimStatus(status);
    }
  }
  const recent = recentUserMessages(input.transcriptPath, input.recentMessages);
  if (recent) state.recent = recent;
  return state;
}
