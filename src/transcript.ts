import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

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

const TAIL_START_BYTES = 256 * 1024;

/**
 * At least the last `n` turns (all of them if the transcript has fewer), reading
 * only the file's end: a window from the end that doubles until it holds `n`
 * turns. A long session's transcript runs to tens of MB; its last turns are near the end.
 */
export function readTranscriptTail(path: string | undefined, n: number, startBytes = TAIL_START_BYTES): Turn[] {
  if (!path || n <= 0) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    for (let win = Math.max(1, startBytes); ; win *= 2) {
      const len = Math.min(win, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      // mid-file, the window's first line is a fragment (maybe a cut character too)
      if (len < size) text = text.slice(text.indexOf('\n') + 1);
      const turns = parseTranscript(text);
      if (turns.length >= n || len === size) return turns;
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
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

export type ToolUse = { name: string; input: Record<string, unknown> };

/**
 * Main-loop tool calls of the current turn: those after the first user entry
 * carrying `promptId` (every user entry of a turn carries it; assistant entries
 * do not). Without a match, those after the last typed user prompt.
 */
export function turnToolUses(jsonl: string, promptId?: string): ToolUse[] {
  const entries: Entry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (!e.isSidechain) entries.push(e);
    } catch {
      // skip
    }
  }
  let start = promptId ? entries.findIndex((e) => e.type === 'user' && e.promptId === promptId) : -1;
  if (start < 0) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === 'user' && typeof e.message?.content === 'string') {
        start = i;
        break;
      }
    }
  }
  const out: ToolUse[] = [];
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content as (Block & { name?: string; input?: Record<string, unknown> })[]) {
      if (b.type === 'tool_use' && typeof b.name === 'string') out.push({ name: b.name, input: b.input ?? {} });
    }
  }
  return out;
}
