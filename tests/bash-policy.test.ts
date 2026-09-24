import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsGitStatus } from '../src/bash-policy.ts';
import { parseShell } from '../src/shell.ts';

test('needsGitStatus for git, file writers, redirects and inline scripts only', () => {
  for (const c of ['git status', 'rm -rf dist', 'mv a b', 'echo x > f', 'sed -i s/a/b/ f', 'find . -delete', "python3 - <<'EOF'\nopen('f','w')\nEOF", 'ls | xargs rm']) {
    assert.equal(needsGitStatus(parseShell(c)), true, c);
  }
  for (const c of ['npm test', 'curl https://x', 'ls -la', 'node x.js', 'cat f | grep x']) {
    assert.equal(needsGitStatus(parseShell(c)), false, c);
  }
});

