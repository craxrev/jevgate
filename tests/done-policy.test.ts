import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, blockOutput, nextCounter, coverageWords, QUESTIONS } from '../src/done-policy.ts';
import type { JevResponse } from '../src/jev.ts';

const res = (coverage: number, claims_backed: number, leftovers: number, asks_user: number): JevResponse => ({
  model: 'j',
  answers: {
    coverage: { type: 'score', score: coverage, legend: {}, probabilities: {}, confidence: 0.9 },
    claims_backed: { type: 'noul', noul: claims_backed },
    leftovers: { type: 'noul', noul: leftovers },
    asks_user: { type: 'noul', noul: asks_user },
  },
});
const t = { coverMin: 2.5, claimsMin: 0.5, leftoverMax: 0.9 };

test('allows a complete, honest, clean diff', () => {
  assert.equal(decide(res(2.98, 0.9, 0.05, 0.02), t).action, 'allow');
});

test('blocks with named problems', () => {
  const d = decide(res(2.0, 0.9, 0.05, 0.02), t);
  assert.equal(d.action, 'block');
  assert.match(d.reason, /main change is there, but something .* still missing .*\(coverage 2\.0 of 3\)/);
  assert.match(decide(res(1.0, 0.9, 0.05, 0.02), t).reason, /only a small part/);
  assert.match(decide(res(0.3, 0.9, 0.05, 0.02), t).reason, /does not address/);
  const d2 = decide(res(2.9, 0.2, 0.95, 0.02), t);
  assert.match(d2.reason, /claims work not visible/);
  assert.match(d2.reason, /leftovers/);
});

test('a question to the user is never blocked', () => {
  assert.equal(decide(res(0.1, 0.1, 0.99, 0.8), t).action, 'allow');
});

test('coverage is a four-rung score and the words follow the rungs', () => {
  const q = QUESTIONS.coverage!;
  assert.equal(q.type, 'score');
  if (q.type === 'score') assert.equal(q.criteria.length, 4);
  assert.match(coverageWords(0.2), /does not address/);
  assert.match(coverageWords(1.2), /small part/);
  assert.match(coverageWords(2.4), /still missing/);
  assert.throws(() => decide({ model: 'j', answers: {} }, t), /coverage/);
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
