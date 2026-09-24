import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inScope, outsidePath, type Scope } from '../src/scope.ts';
import { parseShell } from '../src/shell.ts';

const ROOT = '/Users/me/dev/repo';
const scope: Scope = { cwd: ROOT, roots: [ROOT], session: 'f80c2b43-a0e6', home: '/Users/me' };
const out = (command: string, s: Scope = scope) => outsidePath(parseShell(command), s);

test('inScope: under the start folder or an added one, and the own scratchpad only', () => {
  assert.equal(inScope(`${ROOT}/src/a.ts`, scope), true);
  assert.equal(inScope(ROOT, scope), true);
  assert.equal(inScope(`${ROOT}-other/a.ts`, scope), false);
  assert.equal(inScope('/private/tmp/claude-501/-Users-me-dev-repo/f80c2b43-a0e6/scratchpad/x.txt', scope), true);
  assert.equal(inScope('/private/tmp/claude-501/-Users-me-dev-repo/another-session/scratchpad/x.txt', scope), false);
  assert.equal(inScope('/tmp/claude-501', scope), false);
  assert.equal(inScope('/opt/data/x', { ...scope, roots: [ROOT, '/opt/data'] }), true);
});

// the probe on 2.1.282: which read-only commands Claude Code passes without its classifier
test('outsidePath matches what Claude Code sends to its classifier', () => {
  for (const c of ['ls -l /tmp/x.txt', 'cat /tmp/x.txt', 'ls -d ~/nope', 'ls ../', 'cat /etc/hosts', 'cd /tmp', 'ls -d ~', 'cd']) assert.ok(out(c), c);
  for (const c of ['ls ./a.txt', 'ls a.txt 2>&1', 'ls a.txt; git status --short', 'git log origin/main', 'grep -rn foo src']) assert.equal(out(c), undefined, c);
});

test('a cd moves where the later segments resolve; the shell may sit below the start', () => {
  assert.equal(out('cd sub && ls ../a.txt'), undefined);
  assert.equal(out('cd sub && ls ../../x'), '../../x');
  assert.equal(out('ls ../a.txt', { ...scope, cwd: `${ROOT}/sub` }), undefined);
  assert.equal(out('ls ../../x', { ...scope, cwd: `${ROOT}/sub` }), '../../x');
});

test('flag values and git -C count', () => {
  assert.equal(out('git -C /other/repo status'), '/other/repo');
  assert.equal(out('ls --color=auto src'), undefined);
  assert.equal(out('diff --from-file=/etc/hosts a'), '/etc/hosts');
});
