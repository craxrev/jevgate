import type { Questions } from './jev.ts';

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

/** What Jev sees: the goal and one line plus a head snippet per candidate. Never full outputs. */
export function buildRankState(messages: readonly Msg[], cands: readonly Candidate[], headChars: number): RankState {
  const goal = messages
    .filter((m) => m.role === 'user' && m.text.trim() && !(m.toolResults?.length))
    .slice(-3)
    .map((m) => (m.text.length > 1500 ? m.text.slice(0, 1500) + '…' : m.text));
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

export function rankQuestions(cands: readonly Candidate[]): Questions {
  const q: Questions = {};
  cands.forEach((c, i) => {
    q[`keep_${c.id}`] = {
      type: 'noul',
      instructions:
        `To finish \`goal\`, the assistant will still need the FULL output of \`calls[${i}]\` (${c.tool}) word for word. ` +
        'The head snippet already shown is not enough, and re-running the tool later is not an acceptable substitute.',
      criteria: {
        true: 'Exact content beyond the head is still load-bearing for the ongoing task.',
        false: 'The head is enough, the content is stale, or re-running is fine.',
      },
    };
  });
  return q;
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
