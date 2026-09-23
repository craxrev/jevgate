import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, latestUserPrompt, firstUserPrompt, recentTurns, turnToolUses } from '../src/transcript.ts';

const lines = [
  { type: 'mode', mode: 'normal' },
  { type: 'user', promptId: 'p1', message: { role: 'user', content: 'first ask' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }, { type: 'tool_use', id: 't1' }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } },
  { type: 'user', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } },
  { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent chatter' } },
  { type: 'user', promptId: 'p2', message: { role: 'user', content: 'second ask' } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

test('parseTranscript keeps only main-thread human and assistant text', () => {
  const t = parseTranscript(lines + '\nnot json\n');
  assert.deepEqual(
    t.map((x) => [x.role, x.text]),
    [
      ['user', 'first ask'],
      ['assistant', 'working'],
      ['user', 'second ask'],
      ['assistant', 'done'],
    ],
  );
});

test('prompt lookups', () => {
  const t = parseTranscript(lines);
  assert.equal(firstUserPrompt(t), 'first ask');
  assert.equal(latestUserPrompt(t), 'second ask');
  assert.equal(latestUserPrompt(t, 'p1'), 'first ask');
  assert.equal(latestUserPrompt(t, 'missing'), 'second ask');
});

test('recentTurns caps count and length', () => {
  const t = parseTranscript(lines);
  const r = recentTurns(t, 2, 3);
  assert.equal(r.length, 2);
  assert.equal(r[1]!.text, 'don […]');
});

test('turnToolUses: tool calls after the turn prompt, older turns and subagents left out', () => {
  const u = (content: unknown, promptId?: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', promptId, message: { role: 'user', content }, ...extra });
  const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] }, ...extra });
  const jsonl = [
    u('first ask', 'p1'),
    tool('Edit', { file_path: 'a.ts' }),
    u([{ type: 'tool_result' }], 'p1'),
    u('now run git log', 'p2'),
    tool('Bash', { command: 'git log --oneline' }),
    tool('Write', { file_path: 'x' }, { isSidechain: true }),
    u([{ type: 'tool_result' }], 'p2'),
    u('Stop hook feedback: blocked', 'p2'),
    tool('Bash', { command: 'ls' }),
  ].join('\n');
  assert.deepEqual(turnToolUses(jsonl, 'p2').map((t) => t.name + ' ' + String(t.input.command)), ['Bash git log --oneline', 'Bash ls']);
  assert.deepEqual(turnToolUses(jsonl, 'p1').map((t) => t.name), ['Edit', 'Bash', 'Bash']);
  assert.deepEqual(turnToolUses(jsonl).map((t) => t.name), ['Bash'], 'no prompt id: after the last typed prompt');
});
