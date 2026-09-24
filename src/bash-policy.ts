// The Bash guard's state and hook outputs. What Jev is asked lives in
// facts.ts (shared with the file guard); the free-set check in free.ts decides
// beforehand which commands never get here.
import type { Parsed } from './shell.ts';

/** What Jev sees. Built by the hook from the tool input and local git, never from a model. */
export type BashState = {
  /** As written by the assistant. Not segmented. */
  command: string;
  cwd?: string;
  /** `git rev-parse --show-toplevel`, when `cwd` is inside a repository. */
  repo_root?: string;
  /** `git remote -v`. */
  remotes?: string;
  /** `git status --porcelain`, only when the command touches git or files. */
  git_status?: string;
  /** `git branch --show-current`. */
  current_branch?: string;
  /** Whether the current branch has an upstream. */
  branch_pushed?: boolean;
  home?: string;
  /** Hosts the user declared as theirs (config `knownHosts`). */
  known_hosts?: string[];
  /** The last few turns of the conversation, both roles, oldest first. */
  recent?: { role: 'user' | 'assistant'; text: string }[];
};

const FILE_WRITERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'dd', 'shred', 'truncate', 'tee', 'ln', 'install', 'rsync', 'unlink']);

/** Whether `git status --porcelain` belongs in the state: a git command, a file writer, a redirect, or an inline script. */
export function needsGitStatus(parsed: Parsed): boolean {
  if (parsed.scripts.length > 0) return true;
  if (parsed.syntax.includes('redirect')) return true;
  return parsed.segments.some(
    (s) =>
      s.program === 'git' ||
      FILE_WRITERS.has(s.program) ||
      (s.program === 'sed' && s.flags.some((f) => f === '-i' || f.startsWith('-i') || f === '--in-place')) ||
      (s.program === 'find' && s.flags.includes('-delete')) ||
      s.program === 'xargs',
  );
}

/** Jev unreachable where nothing else judges (bypass, dontAsk): answer.sh refuses with this. */
export const UNREACHABLE_REASON =
  'jevgate: Jev unreachable, refusing to run unguarded. Switch to auto mode (Shift+Tab) or retry.';

/** The gateway in front of Jev refuses some requests by their content; where nothing else judges, answer.sh asks with this. */
export const BLOCKED_REASON = 'jevgate: asking · Jev could not judge this (request blocked by its gateway)';
