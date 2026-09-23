import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyOutput, allowOutput, askOutput, failsClosed, needsGitStatus } from '../src/bash-policy.ts';
import { parseShell } from '../src/shell.ts';

test('failsClosed only in modes with no review behind the hook', () => {
  assert.equal(failsClosed('bypassPermissions'), true);
  assert.equal(failsClosed(undefined), true);
  assert.equal(failsClosed('auto'), false);
  assert.equal(failsClosed('default'), false);
  assert.equal(failsClosed('acceptEdits'), false);
});

test('needsGitStatus for git, file writers, redirects and inline scripts only', () => {
  for (const c of ['git status', 'rm -rf dist', 'mv a b', 'echo x > f', 'sed -i s/a/b/ f', 'find . -delete', "python3 - <<'EOF'\nopen('f','w')\nEOF", 'ls | xargs rm']) {
    assert.equal(needsGitStatus(parseShell(c)), true, c);
  }
  for (const c of ['npm test', 'curl https://x', 'ls -la', 'node x.js', 'cat f | grep x']) {
    assert.equal(needsGitStatus(parseShell(c)), false, c);
  }
});

test('allowOutput matches the PreToolUse contract', () => {
  const o = allowOutput('r');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, 'r');
});

test('askOutput matches the PreToolUse contract', () => {
  const o = askOutput('r');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, 'r');
});

test('denyOutput matches the PreToolUse contract', () => {
  const o = denyOutput('r');
  assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(o.hookSpecificOutput.permissionDecisionReason, 'r');
});
