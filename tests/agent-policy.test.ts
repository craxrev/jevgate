import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState, decide } from '../src/agent-policy.ts';
import type { JevResponse } from '../src/jev.ts';

const res = (p: number): JevResponse => ({ model: 'j', answers: { in_context: { type: 'noul', noul: p } } });

test('buildState carries recent turns and the subagent request', () => {
  const s = buildState([{ role: 'user', text: 'hi' }], { subagent_type: 'Explore', prompt: 'find x' });
  assert.equal(s.recent.length, 1);
  assert.equal(s.subagent.type, 'Explore');
  assert.equal(s.subagent.prompt, 'find x');
});

test('denies only at or above threshold', () => {
  assert.equal(decide(res(0.97), 0.95).action, 'deny');
  assert.equal(decide(res(0.94), 0.95).action, 'pass');
});

