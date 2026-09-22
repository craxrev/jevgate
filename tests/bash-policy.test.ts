import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, DEFAULT_THRESHOLDS, QUESTIONS, decide, denyOutput, needsGitStatus, topScores, type Category } from '../src/bash-policy.ts';
import { parseShell } from '../src/shell.ts';
import { fromRaw, bashThresholds, DEFAULTS } from '../src/config.ts';
import type { JevResponse } from '../src/jev.ts';

const res = (over: Partial<Record<Category, number>>): JevResponse => {
  const answers: JevResponse['answers'] = {};
  for (const c of CATEGORIES) answers[c] = { type: 'noul', noul: over[c] ?? 0.05 };
  return { model: 'j', answers };
};

test('one noul question per category, all naming the state fields', () => {
  assert.deepEqual(Object.keys(QUESTIONS), [...CATEGORIES]);
  for (const c of CATEGORIES) {
    const q = QUESTIONS[c]!;
    assert.equal(q.type, 'noul');
    assert.match(q.instructions, /`command`/);
    assert.match(q.instructions, /`repo_root`/);
    assert.ok(q.criteria?.true && q.criteria.false, c);
  }
  assert.match(QUESTIONS.exceeds_request!.instructions, /`recent`/);
  assert.match(QUESTIONS.destroys_uncommitted_work!.instructions, /`git_status`/);
  assert.match(QUESTIONS.exfiltrates!.instructions, /`remotes`/);
});

test('decide is ok when every score is under its threshold', () => {
  const d = decide(res({ exfiltrates: 0.59, reads_secrets: 0.3, destroys_uncommitted_work: 0.49 }), DEFAULT_THRESHOLDS);
  assert.equal(d.action, 'ok');
  assert.equal(d.scores.exfiltrates, 0.59);
});

test('decide denies at the threshold and names the category and score', () => {
  const d = decide(res({ rewrites_shared_history: 0.5 }), DEFAULT_THRESHOLDS);
  assert.equal(d.action, 'deny');
  if (d.action === 'deny') {
    assert.equal(d.category, 'rewrites_shared_history');
    assert.equal(d.reason, 'jevgate: denied, rewrites_shared_history 0.50 (threshold 0.50)');
  }
});

test('decide picks the category furthest over its threshold', () => {
  const d = decide(res({ exfiltrates: 0.97, reads_secrets: 0.98, destroys_uncommitted_work: 0.55 }), DEFAULT_THRESHOLDS);
  assert.equal(d.action, 'deny');
  if (d.action === 'deny') assert.equal(d.category, 'reads_secrets');
  const e = decide(res({ exfiltrates: 0.7, destroys_uncommitted_work: 0.65 }), DEFAULT_THRESHOLDS);
  if (e.action === 'deny') assert.equal(e.category, 'destroys_uncommitted_work'); // 0.15 over vs 0.10 over
});

test('a threshold of 0 is log-only: exceeds_request never denies by default', () => {
  const d = decide(res({ exceeds_request: 0.99 }), DEFAULT_THRESHOLDS);
  assert.equal(d.action, 'ok');
  assert.equal(d.scores.exceeds_request, 0.99);
  const strict = decide(res({ exceeds_request: 0.99 }), { ...DEFAULT_THRESHOLDS, exceeds_request: 0.9 });
  assert.equal(strict.action, 'deny');
});

test('decide throws when Jev omits a category', () => {
  const r = res({});
  delete r.answers.exfiltrates;
  assert.throws(() => decide(r, DEFAULT_THRESHOLDS), /exfiltrates/);
});

test('config maps per-category options onto thresholds, defaults match the policy', () => {
  assert.deepEqual(bashThresholds(DEFAULTS), DEFAULT_THRESHOLDS);
  const cfg = fromRaw({ bashDenyExfil: '0.8', bashDenyExceeds: 0.7 });
  const t = bashThresholds(cfg);
  assert.equal(t.exfiltrates, 0.8);
  assert.equal(t.exceeds_request, 0.7);
  assert.equal(t.reads_secrets, 0.6);
  assert.equal(cfg.bashRecentMessages, 5);
});

test('needsGitStatus for git, file writers, redirects and inline scripts only', () => {
  for (const c of ['git status', 'rm -rf dist', 'mv a b', 'echo x > f', 'sed -i s/a/b/ f', 'find . -delete', "python3 - <<'EOF'\nopen('f','w')\nEOF", 'ls | xargs rm']) {
    assert.equal(needsGitStatus(parseShell(c)), true, c);
  }
  for (const c of ['npm test', 'curl https://x', 'ls -la', 'node x.js', 'cat f | grep x']) {
    assert.equal(needsGitStatus(parseShell(c)), false, c);
  }
});

test('topScores lists the highest two', () => {
  assert.equal(topScores({ a: 0.1, b: 0.9, c: 0.5 }), 'b 0.90, c 0.50');
});

test('denyOutput matches the PreToolUse contract', () => {
  const o = denyOutput('r');
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, 'r');
});
