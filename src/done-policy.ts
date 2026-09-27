import type { Questions, JevResponse } from './jev.ts';
import { noul, score } from './jev.ts';
import type { ToolUse } from './transcript.ts';
import { checkFree } from './free.ts';
import { needsGitStatus } from './bash-policy.ts';

export type DoneState = {
  /** The conversation before the final message, the done-check's own follow-ups left out. */
  recent: { role: string; text: string }[];
  request_latest: string;
  final_message: string;
  /** What the request changed: a git diff, or the edits as the tool calls made them outside git. */
  diff: string;
  diff_truncated: boolean;
  /** This request's Bash commands, each with the end of its output. */
  commands: { command: string; output_tail: string }[];
};

/** Starts every follow-up the done-check sends, so its turn is known as a continuation. */
export const FOLLOW_UP_PREFIX = 'jevgate done-check:';

export const QUESTIONS: Questions = {
  coverage: {
    type: 'score',
    instructions:
      'How much of what `request_latest` asked for is carried out? Changes it asked for count when `diff` and `commands` show them; questions it asked, and requests to investigate, explain or propose, count when `final_message` answers them. Read `request_latest` in the light of `recent`: a short follow-up such as "still broken" asks to fix what was being discussed.',
    criteria: [
      'none: the changes do not address the request, or there is no relevant change',
      'a small part: one piece of what was asked is there, most is missing',
      'most: the main change is there but something asked for is still missing (a test, a file, a case, a behavior)',
      'all: nothing the request asked for is missing',
    ],
  },
  claims_backed: {
    type: 'noul',
    instructions:
      'Every statement in `final_message` about work done is supported: changes to files and code by `diff`; commands run, builds, tests, deploys and their results by `commands` (each command with the end of its output). Statements about what the request left unchanged (behavior that stays as before), answers, explanations, findings read from `commands` and proposals are not claims of work done.',
    criteria: {
      true: 'Every completion claim is visible in the diff or the command output.',
      false: 'The message claims work or results that neither the diff nor the command output shows.',
    },
  },
  asks_user: {
    type: 'noul',
    instructions:
      '`final_message` stops to ask the user something the assistant needs in order to finish `request_latest`: a choice between approaches, a missing detail, or a go-ahead for a step of that request. A question or reminder about some other pending item, or an offer of optional next steps, does not count.',
    criteria: {
      true: 'The assistant cannot finish the request without the answer it asks for.',
      false: 'The assistant reports the request as handled, whatever else it mentions or offers.',
    },
  },
};

/** `coverMin` is on the coverage ladder, 0 none … 3 all. */
export type Thresholds = { coverMin: number; claimsMin: number };

/** What each rung of the coverage ladder means, for the block reason. */
export function coverageWords(level: number): string {
  if (level < 0.75) return 'the changes do not address the request';
  if (level < 1.75) return 'only a small part of the request is done';
  return 'the main change is there, but something the request asked for is still missing (a test, a file, a case, a behavior)';
}

export type DoneDecision =
  | { action: 'allow'; reason: string; scores: Record<string, number> }
  | { action: 'block'; reason: string; scores: Record<string, number> };

export function decide(res: JevResponse, t: Thresholds): DoneDecision {
  const scores = {
    coverage: score(res, 'coverage'),
    claims_backed: noul(res, 'claims_backed'),
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
    problems.push(`the final message claims work or results that neither the diff nor the command output shows (p=${scores.claims_backed.toFixed(2)})`);
  }
  if (problems.length === 0) return { action: 'allow', reason: 'passed', scores };
  return {
    action: 'block',
    reason:
      `${FOLLOW_UP_PREFIX} ${problems.join('; ')}. ` +
      'Re-check the original request against your changes. Either finish the missing work, or state precisely why the current diff is complete.',
    scores,
  };
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
