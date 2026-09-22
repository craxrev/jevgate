import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidates,
  apply,
  reductionRatio,
  buildRankState,
  rankQuestions,
  pickRestore,
  truncateText,
  type Msg,
} from '../src/compact-core.ts';

const big = (n: number, ch = 'x') => ch.repeat(n);

function call(id: string, tool: string, chars: number, input: Record<string, unknown> = {}): [Msg, Msg] {
  const text = big(chars, id[id.length - 1]);
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text }], handle: `h-${id}-a` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }], handle: `h-${id}-u` },
  ];
}

function transcript(): Msg[] {
  return [
    { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [], handle: 'h0' },
    ...call('t1', 'Read', 5000, { file_path: 'src/a.ts' }),
    ...call('t2', 'Bash', 8000, { command: 'npm test' }),
    ...call('t3', 'Edit', 2000, { file_path: 'src/a.ts' }),
    ...call('t4', 'Grep', 3000, { pattern: 'foo' }),
    { role: 'assistant', text: 'Fixed.', toolUses: [], handle: 'h9' },
    { role: 'user', text: 'thanks, now the other one', toolUses: [], handle: 'h10' },
  ];
}

test('candidates skip the first message, the newest N, edit results, and short outputs', () => {
  const msgs = transcript();
  const c = candidates(msgs, { preserveRecent: 2, headChars: 300 });
  assert.deepEqual(c.map((x) => x.id).sort(), ['t1', 't2', 't4']);
  const pinnedRecent = candidates(msgs, { preserveRecent: 4, headChars: 300 });
  assert.deepEqual(pinnedRecent.map((x) => x.id).sort(), ['t1', 't2']);
});

test('apply truncates only the chosen results and keeps other objects identical', () => {
  const msgs = transcript();
  const out = apply(msgs, new Set(['t2']), 300);
  assert.equal(out.length, msgs.length);
  assert.strictEqual(out[0], msgs[0]);
  assert.strictEqual(out[1], msgs[1]);
  const t2user = out[4]!;
  assert.notStrictEqual(t2user, msgs[4]);
  assert.equal(t2user.handle, undefined);
  assert.match(t2user.toolResults![0]!.text, /^2{300}\n\[jevgate: output truncated, 8000 chars/);
  const t2asst = out[3]!;
  assert.equal(t2asst.handle, undefined);
  assert.match(t2asst.toolUses[0]!.text!, /truncated/);
  assert.equal(t2asst.toolUses[0]!.tool_use_id, 't2');
  assert.strictEqual(out[5], msgs[5]);
});

test('no result is ever left without its call', () => {
  const msgs = transcript();
  const out = apply(msgs, new Set(['t1', 't2', 't4']), 300);
  const uses = new Set(out.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)));
  for (const m of out) for (const r of m.toolResults ?? []) assert.ok(uses.has(r.tool_use_id));
});

test('reductionRatio reflects truncated chars', () => {
  const msgs = transcript();
  const out = apply(msgs, new Set(['t1', 't2', 't4']), 300);
  const r = reductionRatio(msgs, out);
  assert.ok(r > 0.6 && r < 1, String(r));
});

test('truncateText leaves short text alone', () => {
  assert.equal(truncateText('abc', 300), 'abc');
});

test('rank state exposes heads and goal, never full outputs', () => {
  const msgs = transcript();
  const c = candidates(msgs, { preserveRecent: 2, headChars: 300 });
  const s = buildRankState(msgs, c, 300);
  assert.deepEqual(s.goal, ['Fix the failing test. Never edit src/generated.', 'thanks, now the other one']);
  for (const call of s.calls) assert.ok(call.head.length <= 300);
  const q = rankQuestions(c);
  assert.deepEqual(Object.keys(q).sort(), ['keep_t1', 'keep_t2', 'keep_t4']);
});

test('pickRestore keeps top K above the floor', () => {
  const scores = new Map([
    ['a', 0.9],
    ['b', 0.2],
    ['c', 0.6],
    ['d', 0.5],
  ]);
  assert.deepEqual([...pickRestore(scores, 2, 0.3)].sort(), ['a', 'c']);
  assert.deepEqual([...pickRestore(scores, 10, 0.3)].sort(), ['a', 'c', 'd']);
  assert.deepEqual([...pickRestore(scores, 0, 0.3)], []);
});
