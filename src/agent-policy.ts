import type { Questions, JevResponse } from './jev.ts';
import { noul } from './jev.ts';
import type { Turn } from './transcript.ts';

export type AgentState = {
  recent: { role: string; text: string }[];
  subagent: { type?: string; description?: string; prompt?: string };
};

export function buildState(
  recent: Turn[],
  input: { subagent_type?: string; description?: string; prompt?: string },
): AgentState {
  return {
    recent: recent.map((t) => ({ role: t.role, text: t.text })),
    subagent: { type: input.subagent_type, description: input.description, prompt: input.prompt },
  };
}

export const QUESTIONS: Questions = {
  in_context: {
    type: 'noul',
    instructions:
      'The information the `subagent` is asked to find or produce is already present in the `recent` conversation, so the assistant could answer directly without delegating. Tasks that require reading files, searching code, or fetching web pages that are not quoted in `recent` are NOT in context.',
    criteria: {
      true: 'The answer is already on the table; delegating is redundant.',
      false: 'New reading, searching, or computation is genuinely needed.',
    },
  },
};

export type AgentDecision =
  | { action: 'deny'; reason: string; scores: Record<string, number> }
  | { action: 'pass'; reason: string; scores: Record<string, number> };

export function decide(res: JevResponse, threshold: number): AgentDecision {
  const scores = { in_context: noul(res, 'in_context') };
  if (scores.in_context >= threshold) {
    return {
      action: 'deny',
      reason:
        `jevgate: the answer appears to already be in the recent conversation (p=${scores.in_context.toFixed(2)}). ` +
        'Answer directly from context instead of spawning a subagent. If new reading is truly required, say what is missing and retry.',
      scores,
    };
  }
  return { action: 'pass', reason: `below threshold (p=${scores.in_context.toFixed(2)})`, scores };
}

export function denyOutput(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
