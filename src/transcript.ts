// The conversation as the guards read it, from the session's own rows
// (`$.session.messages()`): no transcript file is read.

export type Turn = { role: 'user' | 'assistant'; text: string };

/** One row as `$.session.messages()` answers it, narrowed to what is read here. */
export type Row = {
  role: 'user' | 'assistant';
  text: string;
  /** `text` is the tool's output, once answered. */
  toolUses?: readonly { tool: string; input: Record<string, unknown>; text?: string }[];
};

// system reminders and command echoes are not the person's words
const NOT_WORDS = /^<(system-reminder|local-command|command-name|bash-input)/;

/** Human and assistant text turns of the main conversation, oldest first. */
export function turnsOf(rows: readonly Row[]): Turn[] {
  const turns: Turn[] = [];
  for (const r of rows) {
    const text = r.text.trim();
    if (!text) continue;
    if (r.role === 'user' && NOT_WORDS.test(text)) continue;
    turns.push({ role: r.role, text });
  }
  return turns;
}

export function latestUserPrompt(turns: Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') return turns[i]!.text;
  }
  return undefined;
}

export function recentTurns(turns: Turn[], n: number, maxChars = 2000): Turn[] {
  if (n <= 0) return [];
  return turns.slice(-n).map((t) => ({
    ...t,
    text: t.text.length > maxChars ? t.text.slice(0, maxChars) + ' […]' : t.text,
  }));
}

export type ToolUse = { name: string; input: Record<string, unknown>; output?: string };

/**
 * Tool calls since the latest typed user prompt: the turn now ending. A prompt
 * `continues` accepts (the done-check's own follow-up) does not start a turn.
 */
export function turnToolUses(rows: readonly Row[], continues: (text: string) => boolean = () => false): ToolUse[] {
  let start = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const text = r.text.trim();
    if (r.role === 'user' && text && !NOT_WORDS.test(text) && !continues(text)) {
      start = i;
      break;
    }
  }
  const out: ToolUse[] = [];
  for (const r of rows.slice(start + 1)) {
    if (r.role !== 'assistant') continue;
    for (const u of r.toolUses ?? []) out.push({ name: u.tool, input: u.input, ...(u.text !== undefined ? { output: u.text } : {}) });
  }
  return out;
}
