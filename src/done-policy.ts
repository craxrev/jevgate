import type { Questions, JevResponse } from './jev.ts';
import { noul } from './jev.ts';

export type DoneState = {
  request_first?: string;
  request_latest?: string;
  final_message: string;
  diff: string;
  diff_truncated: boolean;
};

export const QUESTIONS: Questions = {
  covers: {
    type: 'noul',
    instructions:
      'The changes in `diff` implement everything `request_latest` asked for. If `request_latest` was a question, a discussion, or asked only for analysis or a plan with no code change, answer true.',
    criteria: {
      true: 'Nothing the request asked for is missing from the diff.',
      false: 'A requested change, file, test, or behavior is absent from the diff.',
    },
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

export type Thresholds = { coverMin: number; claimsMin: number; leftoverMax: number };

export type DoneDecision =
  | { action: 'allow'; reason: string; scores: Record<string, number> }
  | { action: 'block'; reason: string; scores: Record<string, number> };

export function decide(res: JevResponse, t: Thresholds): DoneDecision {
  const scores = {
    covers: noul(res, 'covers'),
    claims_backed: noul(res, 'claims_backed'),
    leftovers: noul(res, 'leftovers'),
    asks_user: noul(res, 'asks_user'),
  };
  if (scores.asks_user >= 0.7) {
    return { action: 'allow', reason: 'final message asks the user', scores };
  }
  const problems: string[] = [];
  if (scores.covers < t.coverMin) {
    problems.push(`the diff does not appear to cover the request (p=${scores.covers.toFixed(2)})`);
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
