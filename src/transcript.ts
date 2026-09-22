import { readFileSync } from 'node:fs';

export type Turn = { role: 'user' | 'assistant'; text: string; promptId?: string };

type Block = { type?: string; text?: string };
type Entry = {
  type?: string;
  isSidechain?: boolean;
  promptId?: string;
  message?: { role?: string; content?: string | Block[] };
};

function textOf(content: string | Block[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Human and assistant text turns of the main conversation, oldest first. */
export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const text = textOf(e.message?.content).trim();
    if (!text) continue;
    // system reminders and command echoes are not the person's words
    if (e.type === 'user' && /^<(system-reminder|local-command|command-name|bash-input)/.test(text)) continue;
    turns.push({ role: e.type, text, promptId: e.promptId });
  }
  return turns;
}

export function readTranscript(path: string | undefined): Turn[] {
  if (!path) return [];
  try {
    return parseTranscript(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

export function latestUserPrompt(turns: Turn[], promptId?: string): string | undefined {
  if (promptId) {
    const hit = turns.find((t) => t.role === 'user' && t.promptId === promptId);
    if (hit) return hit.text;
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') return turns[i]!.text;
  }
  return undefined;
}

export function firstUserPrompt(turns: Turn[]): string | undefined {
  return turns.find((t) => t.role === 'user')?.text;
}

export function recentTurns(turns: Turn[], n: number, maxChars = 2000): Turn[] {
  return turns.slice(-n).map((t) => ({
    ...t,
    text: t.text.length > maxChars ? t.text.slice(0, maxChars) + ' […]' : t.text,
  }));
}
