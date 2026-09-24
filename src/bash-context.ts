// Deterministic context for the Bash guard: local git facts and the latest
// turns. No model is involved; the module passes in a command runner (git
// through `$.process.run`) and the session's turns, so tests can fake both.
import type { Turn } from './transcript.ts';
import { needsGitStatus, type BashState } from './bash-policy.ts';
import type { Parsed } from './shell.ts';

/** Runs a program and resolves stdout, or undefined on any failure (`anyExit`: stdout whatever the exit code). */
export type Runner = (program: string, args: string[], cwd: string | undefined, opts?: { anyExit?: boolean }) => Promise<string | undefined> | string | undefined;

const STATUS_MAX_LINES = 200;
const RECENT_MAX_CHARS = 1500;

export type ContextInput = {
  command: string;
  parsed: Parsed;
  cwd?: string;
  /** The conversation so far, oldest first. */
  turns: Turn[];
  recentTurns: number;
  home?: string;
  knownHosts?: string[];
};

export type RecentTurn = { role: 'user' | 'assistant'; text: string };

/**
 * The last `n` turns of the main conversation, both roles, oldest first, each
 * truncated. Jev is told that only user turns are requests and an assistant
 * turn counts only once the user agreed to it.
 */
export function recentTurns(turns: Turn[], n: number): RecentTurn[] | undefined {
  if (n <= 0 || turns.length === 0) return undefined;
  return turns.slice(-n).map((t) => ({
    role: t.role,
    text: t.text.length > RECENT_MAX_CHARS ? t.text.slice(0, RECENT_MAX_CHARS) + ' […]' : t.text,
  }));
}

function trimStatus(out: string): string {
  const lines = out.split('\n').filter(Boolean);
  if (lines.length <= STATUS_MAX_LINES) return lines.join('\n');
  return lines.slice(0, STATUS_MAX_LINES).join('\n') + `\n… ${lines.length - STATUS_MAX_LINES} more`;
}

/** The git calls all start at once, outside a repo too (they fail there). */
export async function gatherState(input: ContextInput, run: Runner): Promise<BashState> {
  const state: BashState = { command: input.command, cwd: input.cwd };
  const git = (...args: string[]) => Promise.resolve(run('git', args, input.cwd));
  const [rootOut, remotes, status, branchOut, upstream] = await Promise.all([
    git('rev-parse', '--show-toplevel'),
    git('remote', '-v'),
    needsGitStatus(input.parsed) ? git('status', '--porcelain') : undefined,
    git('branch', '--show-current'),
    git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'),
  ]);
  const root = rootOut?.trim();
  if (root) {
    state.repo_root = root;
    if (remotes !== undefined) state.remotes = remotes.trim();
    if (status !== undefined) state.git_status = trimStatus(status);
    const branch = branchOut?.trim();
    if (branch) {
      state.current_branch = branch;
      state.branch_pushed = upstream !== undefined;
    }
  }
  if (input.home) state.home = input.home;
  if (input.knownHosts?.length) state.known_hosts = input.knownHosts;
  const recent = recentTurns(input.turns, input.recentTurns);
  if (recent) state.recent = recent;
  return state;
}
