import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, coverageWords, QUESTIONS, turnChangedFiles } from '../src/done-policy.ts';
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

test('turnChangedFiles: file tools and writing Bash count, reads and plain runs do not', () => {
  const b = (command: string) => ({ name: 'Bash', input: { command } });
  assert.equal(turnChangedFiles([b('git log --oneline'), b('ls -la'), b('npm test')]), false);
  assert.equal(turnChangedFiles([{ name: 'Read', input: { file_path: 'a' } }]), false);
  assert.equal(turnChangedFiles([]), false);
  assert.equal(turnChangedFiles([{ name: 'Edit', input: {} }]), true);
  assert.equal(turnChangedFiles([b("sed -i '' s/a/b/ f.ts")]), true);
  assert.equal(turnChangedFiles([b('echo x > notes.md')]), true);
  assert.equal(turnChangedFiles([b('git push 2>&1 | tail -1'), b('git fetch origin'), b('git -C ../x pull --ff-only'), b('git commit -m x'), b('git tag v1')]), false);
  assert.equal(turnChangedFiles([b('git checkout -- a.ts')]), true);
  assert.equal(turnChangedFiles([b('git -C sub stash pop')]), true);
  assert.equal(turnChangedFiles([b('git add -A && git commit -m x > log.txt')]), true, 'the redirect writes');
});
