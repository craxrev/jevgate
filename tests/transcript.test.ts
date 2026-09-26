import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnsOf, latestUserPrompt, recentTurns, turnToolUses, type Row } from '../src/transcript.ts';

// rows as `$.session.messages()` answers them: a tool result is a user row with no text
const rows: Row[] = [
  { role: 'user', text: 'first ask' },
  { role: 'assistant', text: 'working', toolUses: [{ tool: 'Read', input: { file_path: 'a.ts' } }] },
  { role: 'user', text: '' },
  { role: 'user', text: '<system-reminder>ignore me</system-reminder>' },
  { role: 'user', text: 'second ask' },
  { role: 'assistant', text: '', toolUses: [{ tool: 'Edit', input: { file_path: 'b.ts' } }] },
  { role: 'user', text: '' },
  { role: 'assistant', text: 'done', toolUses: [{ tool: 'Bash', input: { command: 'npm test' }, text: '2 passed' }] },
];

test('turnsOf keeps human and assistant text, not reminders or tool results', () => {
  assert.deepEqual(
    turnsOf(rows).map((x) => [x.role, x.text]),
    [
      ['user', 'first ask'],
      ['assistant', 'working'],
      ['user', 'second ask'],
      ['assistant', 'done'],
    ],
  );
});

test('prompt lookups', () => {
  const t = turnsOf(rows);
  assert.equal(latestUserPrompt(t), 'second ask');
  assert.equal(latestUserPrompt([]), undefined);
});

test('recentTurns caps count and length', () => {
  assert.deepEqual(recentTurns(turnsOf(rows), 2, 3), [
    { role: 'user', text: 'sec […]' },
    { role: 'assistant', text: 'don […]' },
  ]);
  assert.deepEqual(recentTurns(turnsOf(rows), 0), []);
});

test('turnToolUses: the calls since the latest typed prompt', () => {
  assert.deepEqual(turnToolUses(rows), [
    { name: 'Edit', input: { file_path: 'b.ts' } },
    { name: 'Bash', input: { command: 'npm test' }, output: '2 passed' },
  ]);
  // a reminder after the prompt does not start a new turn
  assert.equal(turnToolUses([...rows, { role: 'user', text: '<system-reminder>x</system-reminder>' }]).length, 2);
  // neither does a prompt `continues` accepts
  const followed: Row[] = [...rows, { role: 'user', text: 'go on' }, { role: 'assistant', text: 'ok' }];
  assert.equal(turnToolUses(followed).length, 0);
  assert.equal(turnToolUses(followed, (t) => t === 'go on').length, 2);
});
