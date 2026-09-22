import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, blockOutput, nextCounter } from '../src/done-policy.ts';
import type { JevResponse } from '../src/jev.ts';

const res = (covers: number, claims_backed: number, leftovers: number, asks_user: number): JevResponse => ({
  model: 'j',
  answers: {
    covers: { type: 'noul', noul: covers },
    claims_backed: { type: 'noul', noul: claims_backed },
    leftovers: { type: 'noul', noul: leftovers },
    asks_user: { type: 'noul', noul: asks_user },
  },
});
const t = { coverMin: 0.5, claimsMin: 0.5, leftoverMax: 0.9 };

test('allows a complete, honest, clean diff', () => {
  assert.equal(decide(res(0.9, 0.9, 0.05, 0.02), t).action, 'allow');
});

test('blocks with named problems', () => {
  const d = decide(res(0.2, 0.9, 0.05, 0.02), t);
  assert.equal(d.action, 'block');
  assert.match(d.reason, /does not appear to cover/);
  const d2 = decide(res(0.9, 0.2, 0.95, 0.02), t);
  assert.match(d2.reason, /claims work not visible/);
  assert.match(d2.reason, /leftovers/);
});

test('a question to the user is never blocked', () => {
  assert.equal(decide(res(0.1, 0.1, 0.99, 0.8), t).action, 'allow');
});

test('blockOutput uses the top-level Stop contract', () => {
  assert.deepEqual(blockOutput('why'), { decision: 'block', reason: 'why' });
});

test('counter resets on a fresh stop and persists while the hook is re-entering', () => {
  assert.deepEqual(nextCounter(undefined, false), { blocks: 0 });
  assert.deepEqual(nextCounter({ blocks: 1 }, false), { blocks: 0 });
  assert.deepEqual(nextCounter({ blocks: 1 }, true), { blocks: 1 });
  assert.deepEqual(nextCounter(undefined, true), { blocks: 0 });
});
