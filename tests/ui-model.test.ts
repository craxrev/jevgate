import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, tally, statusText, footerLabel, bashRowText, kb } from '../src/ui-model.ts';

const log = [
  { ts: 't', feature: 'bash', action: 'allow', session: 's1', tool_use_id: 'a', scores: { read_only: 0.98, dev_task: 0.01, unsafe: 0.02 }, ms: 340 },
  { ts: 't', feature: 'bash', action: 'pass', session: 's1', tool_use_id: 'b', scores: { read_only: 0.1, dev_task: 0.9, unsafe: 0.7 }, ms: 300 },
  { ts: 't', feature: 'bash', action: 'passthrough', session: 's1', tool_use_id: 'c', command: 'rm x' },
  { ts: 't', feature: 'done', action: 'block', session: 's1' },
  { ts: 't', feature: 'agent', action: 'deny', session: 's2' },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

test('parseLog skips junk lines', () => {
  assert.equal(parseLog('garbage\n' + log + '\n{bad').length, 5);
});

test('tally counts per session', () => {
  const t = tally(parseLog(log), 's1');
  assert.deepEqual(t, { allowed: 1, passed: 1, passthrough: 1, blocks: 1, agentDenies: 0 });
  assert.equal(tally(parseLog(log), 's2').agentDenies, 1);
});

test('statusText is compact and empty when nothing happened', () => {
  assert.equal(statusText({ allowed: 0, passed: 0, passthrough: 0, blocks: 0, agentDenies: 0 }, 0), undefined);
  assert.equal(statusText({ allowed: 3, passed: 1, passthrough: 9, blocks: 0, agentDenies: 0 }, 2), 'jev ✓3 fast-lane · ↷1 classifier · ⇊2 compact');
});

test('footerLabel is the short form', () => {
  assert.equal(footerLabel({ allowed: 0, passed: 0, passthrough: 0, blocks: 0, agentDenies: 0 }, 0), undefined);
  assert.equal(footerLabel({ allowed: 5, passed: 1, passthrough: 9, blocks: 1, agentDenies: 0 }, 1), 'jev ✓5 ↷1 ⛔1 ⇊1');
});

test('bashRowText only for judged commands', () => {
  const [a, b, c] = parseLog(log);
  assert.match(bashRowText(a!)!, /fast-lane · read-only 0\.98.*340ms/);
  assert.match(bashRowText(b!)!, /classifier/);
  assert.equal(bashRowText(c!), undefined);
});

test('kb formatting', () => {
  assert.equal(kb(300), '300');
  assert.equal(kb(8200), '8.2k');
});
