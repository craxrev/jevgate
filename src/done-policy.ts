import type { Questions, JevResponse } from './jev.ts';
import { noul, score } from './jev.ts';
import type { ToolUse } from './transcript.ts';
import { checkFree } from './free.ts';
import { needsGitStatus } from './bash-policy.ts';

export type DoneState = {
  request_first?: string;
  request_latest?: string;
  final_message: string;
  diff: string;
  diff_truncated: boolean;
};

export const QUESTIONS: Questions = {
  coverage: {
    type: 'score',
    instructions:
      'How much of what `request_latest` asked for do the changes in `diff` implement? If `request_latest` was a question, a discussion, or asked only for analysis or a plan with no code change, answer the top level.',
    criteria: [
      'none: the diff does not address the request, or there is no relevant change',
      'a small part: one piece of what was asked is there, most is missing',
      'most: the main change is there but something asked for is still missing (a test, a file, a case, a behavior)',
      'all: nothing the request asked for is missing from the diff',
    ],
  },
  claims_backed: {
    type: 'noul',
    instructions:
      'Every statement in `final_message` about work completed (files changed, functions added, tests written, bugs fixed, commands run successfully) is supported by what `diff` actually contains.',
    criteria: {
      true: 'All completion claims are visible in the diff.',
      false: 'The message claims work that the diff does not show.',
    },
  },
  leftovers: {
    type: 'noul',
    instructions:
      '`diff` adds debugging leftovers: temporary print or console.log statements, TODO or FIXME placeholders standing in for required logic, commented-out code, or hard-coded test values.',
    criteria: {
      true: 'Debug or placeholder leftovers are present in added lines.',
      false: 'Added lines look final.',
    },
  },
  asks_user: {
    type: 'noul',
    instructions:
      '`final_message` asks the user a question, presents options for them to choose, or explicitly waits for their decision before continuing.',
    criteria: {
      true: 'The assistant is handing a decision back to the user.',
      false: 'The assistant is reporting a finished result.',
    },
  },
};

/** `coverMin` is on the coverage ladder, 0 none … 3 all. */
export type Thresholds = { coverMin: number; claimsMin: number; leftoverMax: number };

/** What each rung of the coverage ladder means, for the block reason. */
export function coverageWords(level: number): string {
  if (level < 0.75) return 'the diff does not address the request';
  if (level < 1.75) return 'only a small part of the request is in the diff';
  return 'the main change is there, but something the request asked for is still missing (a test, a file, a case, a behavior)';
}

export type DoneDecision =
  | { action: 'allow'; reason: string; scores: Record<string, number> }
  | { action: 'block'; reason: string; scores: Record<string, number> };

export function decide(res: JevResponse, t: Thresholds): DoneDecision {
  const scores = {
    coverage: score(res, 'coverage'),
    claims_backed: noul(res, 'claims_backed'),
    leftovers: noul(res, 'leftovers'),
    asks_user: noul(res, 'asks_user'),
  };
  if (scores.asks_user >= 0.7) {
    return { action: 'allow', reason: 'final message asks the user', scores };
  }
  const problems: string[] = [];
  if (scores.coverage < t.coverMin) {
    problems.push(`${coverageWords(scores.coverage)} (coverage ${scores.coverage.toFixed(1)} of 3)`);
  }
  if (scores.claims_backed < t.claimsMin) {
    problems.push(`the final message claims work not visible in the diff (p=${scores.claims_backed.toFixed(2)})`);
  }
  if (scores.leftovers > t.leftoverMax) {
    problems.push(`debug leftovers or placeholder TODOs detected in the diff (p=${scores.leftovers.toFixed(2)})`);
  }
  if (problems.length === 0) return { action: 'allow', reason: 'passed', scores };
  return {
    action: 'block',
    reason:
      `jevgate done-check: ${problems.join('; ')}. ` +
      'Re-check the original request against your changes. Either finish the missing work, or state precisely why the current diff is complete.',
    scores,
  };
}

export function blockOutput(reason: string) {
  return { decision: 'block', reason };
}

/** Block counter per session; resets when a fresh (non-hook-triggered) stop arrives. */
export type Counter = { blocks: number };

export function nextCounter(prev: Counter | undefined, stopHookActive: boolean): Counter {
  if (!stopHookActive || !prev) return { blocks: 0 };
  return { blocks: prev.blocks };
}

const FILE_WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** git subcommands that change files in the working tree; push, fetch, pull, commit, tag and the like do not. */
const GIT_EDITS = new Set(['apply', 'am', 'cherry-pick', 'revert', 'merge', 'rebase', 'mv', 'rm', 'checkout', 'switch', 'restore', 'reset', 'stash', 'clean']);

/** The git subcommand of a segment, past `-C <dir>` and `-c <key=value>`. */
function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-C' || args[i] === '-c') i++;
    else if (!args[i]!.startsWith('-')) return args[i];
  }
  return undefined;
}

/**
 * Whether the turn may have changed files: a file tool, or a Bash command that
 * writes (writers, redirects, inline scripts, git commands that edit the tree). A turn that only
 * ran or read things has nothing for the done-check to judge; the repository's
 * older changes are not its work.
 */
export function turnChangedFiles(uses: readonly ToolUse[]): boolean {
  return uses.some((u) => {
    if (FILE_WRITERS.has(u.name)) return true;
    if (u.name !== 'Bash' || typeof u.input.command !== 'string') return false;
    const free = checkFree(u.input.command);
    if (free.free) return false;
    const segments = free.parsed.segments.filter((s) => s.program !== 'git' || GIT_EDITS.has(gitSubcommand(s.args) ?? ''));
    return needsGitStatus({ ...free.parsed, segments });
  });
}
