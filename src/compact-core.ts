import type { Questions, JevResponse } from './jev.ts';
import { noul } from './jev.ts';

/** Structural subset of Claude Code's SessionMessage. */
export type ToolUse = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: true;
  result?: unknown;
};
export type ToolResult = { tool_use_id: string; text: string; isError: boolean; result?: unknown };
export type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
  handle?: string;
};

/** Results that prove a change happened. Never truncated. */
export const PIN_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export type Candidate = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  text: string;
  chars: number;
};

export type CoreOptions = { preserveRecent: number; headChars: number };

const NOTE = (chars: number) =>
  `\n[jevgate: output truncated, ${chars} chars total; re-run the tool if the rest is needed]`;

function pinnedIndexes(messages: readonly Msg[], preserveRecent: number): Set<number> {
  const pinned = new Set<number>([0]);
  for (let i = Math.max(0, messages.length - preserveRecent); i < messages.length; i++) pinned.add(i);
  return pinned;
}

/** Tool results eligible for truncation: unpinned, not an edit, long enough to matter. */
/** The candidates worth asking Jev about: the largest `max`, in original order. */
export function rankable(cands: readonly Candidate[], max = MAX_RANKED): Candidate[] {
  if (cands.length <= max) return [...cands];
  const keep = new Set([...cands].sort((a, b) => b.chars - a.chars).slice(0, max).map((c) => c.id));
  return cands.filter((c) => keep.has(c.id));
}

export function candidates(messages: readonly Msg[], opts: CoreOptions): Candidate[] {
  const pinned = pinnedIndexes(messages, opts.preserveRecent);
  const uses = new Map<string, ToolUse>();
  for (const m of messages) for (const u of m.toolUses) uses.set(u.tool_use_id, u);
  const out: Candidate[] = [];
  messages.forEach((m, i) => {
    if (pinned.has(i) || !m.toolResults) return;
    for (const r of m.toolResults) {
      const u = uses.get(r.tool_use_id);
      if (!u || PIN_TOOLS.has(u.tool)) continue;
      if (r.text.length <= opts.headChars + 120) continue;
      out.push({ id: r.tool_use_id, tool: u.tool, input: u.input, text: r.text, chars: r.text.length });
    }
  });
  return out;
}

export function truncateText(text: string, headChars: number): string {
  if (text.length <= headChars) return text;
  return text.slice(0, headChars) + NOTE(text.length);
}

/**
 * Rebuilds the list with the given results truncated. Untouched messages are the
 * same objects (their engine handle intact); rebuilt ones carry no handle.
 */
export function apply(messages: readonly Msg[], truncate: ReadonlySet<string>, headChars: number): Msg[] {
  return messages.map((m) => {
    const hitResult = m.toolResults?.some((r) => truncate.has(r.tool_use_id)) ?? false;
    const hitUse = m.toolUses.some((u) => truncate.has(u.tool_use_id) && typeof u.text === 'string');
    if (!hitResult && !hitUse) return m;
    const rebuilt: Msg = {
      role: m.role,
      text: m.text,
      toolUses: m.toolUses.map((u) =>
        truncate.has(u.tool_use_id) && typeof u.text === 'string'
          ? { ...u, text: truncateText(u.text, headChars), result: undefined }
          : u,
      ),
    };
    if (m.toolResults) {
      rebuilt.toolResults = m.toolResults.map((r) =>
        truncate.has(r.tool_use_id)
          ? { tool_use_id: r.tool_use_id, text: truncateText(r.text, headChars), isError: r.isError }
          : r,
      );
    }
    return rebuilt;
  });
}

export function totalChars(messages: readonly Msg[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.text.length;
    for (const u of m.toolUses) n += JSON.stringify(u.input).length + (u.text?.length ?? 0);
    for (const r of m.toolResults ?? []) n += r.text.length;
  }
  return n;
}

export function reductionRatio(before: readonly Msg[], after: readonly Msg[]): number {
  const b = totalChars(before);
  if (b === 0) return 0;
  return (b - totalChars(after)) / b;
}

export type RankState = {
  goal: string[];
  calls: { id: string; tool: string; input: string; head: string; chars: number }[];
};

function shortInput(input: Record<string, unknown>, max = 200): string {
  const s = JSON.stringify(input);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Slash-command echoes, their caveats and reminders are not the user's goal. */
const NOT_A_GOAL = /^\s*(<(local-command|command-name|command-message|system-reminder|bash-input|task-notification)|\/[a-z][\w:-]*\s*$)/i;

/** The user's last three real messages, oldest first: what the ranking is judged against. */
export function goalMessages(messages: readonly Msg[], n = 3): string[] {
  return messages
    .filter((m) => m.role === 'user' && m.text.trim() && !(m.toolResults?.length) && !NOT_A_GOAL.test(m.text))
    .slice(-n)
    .map((m) => (m.text.length > 1500 ? m.text.slice(0, 1500) + '…' : m.text));
}

/** What Jev sees: the goal and one line plus a head snippet per candidate. Never full outputs. */
export function buildRankState(messages: readonly Msg[], cands: readonly Candidate[], headChars: number): RankState {
  const goal = goalMessages(messages);
  return {
    goal,
    calls: cands.map((c) => ({
      id: c.id,
      tool: c.tool,
      input: shortInput(c.input),
      head: c.text.slice(0, headChars),
      chars: c.chars,
    })),
  };
}

/** Jev allows at most 255 options in a Choice; the rest are truncated without asking. */
export const MAX_RANKED = 250;
export const NONE_OPTION = 'none';

/**
 * Two questions instead of one per candidate: a Choice over the candidate ids
 * (its probabilities are the ranking) and a noul gate, because Choice mass
 * always lands somewhere even when nothing is needed.
 */
export function rankQuestions(cands: readonly Candidate[]): Questions {
  const criteria: Record<string, string | null> = { [NONE_OPTION]: 'No old output is still needed word for word; the head snippets are enough or re-running is fine.' };
  cands.forEach((c, i) => {
    criteria[c.id] = `calls[${i}] (${c.tool})`;
  });
  return {
    any_needed: {
      type: 'noul',
      instructions:
        'To finish `goal`, the assistant will still need the FULL output of at least one of `calls` word for word. ' +
        'Each entry shows the tool, its input and the first characters of its output (`head`). ' +
        'The head alone is not enough for that call, and re-running the tool later is not an acceptable substitute.',
      criteria: {
        true: 'Some call\'s exact content beyond its head is still load-bearing for the ongoing task.',
        false: 'Every head is enough, the outputs are stale, or re-running is fine.',
      },
    },
    most_needed: {
      type: 'choice',
      instructions:
        'Which entry of `calls` is the assistant most likely to still need in FULL, word for word, to finish `goal`? ' +
        'Options are the call ids; `none` when no full output is needed.',
      criteria,
    },
  };
}

/** Per-candidate keep scores from the Choice probabilities, gated by the noul: nothing scores when the gate is under `gateMin`. */
export function rankScores(res: JevResponse, cands: readonly Candidate[], gateMin: number): Map<string, number> {
  const scores = new Map<string, number>();
  const gate = noul(res, 'any_needed');
  const a = res.answers.most_needed;
  const probs = a && a.type === 'choice' ? a.probabilities : {};
  for (const c of cands) scores.set(c.id, gate < gateMin ? 0 : (probs[c.id] ?? 0));
  return scores;
}

/** Highest-scoring candidates to keep verbatim, capped at topK and floored at minScore. */
export function pickRestore(scores: Map<string, number>, topK: number, minScore: number): Set<string> {
  return new Set(
    [...scores.entries()]
      .filter(([, s]) => s >= minScore)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, topK))
      .map(([id]) => id),
  );
}
