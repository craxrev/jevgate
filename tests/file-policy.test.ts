import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolPath,
  contentHead,
  resolvePath,
  isSensitivePath,
  WRITE_TOOLS,
} from '../src/file-policy.ts';

const HOME = '/Users/me';
const REPO = '/Users/me/dev/repo';

test('toolPath reads file_path or notebook_path', () => {
  assert.equal(toolPath({ file_path: 'a.ts' }), 'a.ts');
  assert.equal(toolPath({ notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(toolPath({ file_path: '  ' }), undefined);
  assert.equal(toolPath(undefined), undefined);
});

test('contentHead takes the new text of any write tool, truncated', () => {
  assert.equal(contentHead({ content: 'abc' }), 'abc');
  assert.equal(contentHead({ new_string: 'x' }), 'x');
  assert.equal(contentHead({ edits: [{ new_string: 'a' }, { new_string: 'b' }] }), 'a\nb');
  assert.equal(contentHead({ content: 'y'.repeat(500) }, 400), 'y'.repeat(400) + ' […]');
  assert.equal(contentHead({ file_path: 'f' }), undefined);
});

test('resolvePath expands ~ and resolves relative paths against cwd', () => {
  assert.equal(resolvePath('~/.zshrc', REPO, HOME), '/Users/me/.zshrc');
  assert.equal(resolvePath('src/a.ts', REPO, HOME), `${REPO}/src/a.ts`);
  assert.equal(resolvePath('../other/x', REPO, HOME), '/Users/me/dev/other/x');
  assert.equal(resolvePath('/etc/hosts', REPO, HOME), '/etc/hosts');
  assert.equal(resolvePath(`${REPO}/./src/../a.ts`, REPO, HOME), `${REPO}/a.ts`);
});

test('isSensitivePath matches credential files, not ordinary ones', () => {
  for (const p of ['/Users/me/.ssh/id_rsa', '/Users/me/dev/repo/.env', '/Users/me/dev/repo/.env.local', '/Users/me/.aws/credentials', '/Users/me/.claude/settings.json', '/x/key.pem']) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ['/Users/me/dev/repo/src/env.ts', '/Users/me/dev/repo/.env.example', '/Users/me/.claude/skills/foo/SKILL.md', '/Users/me/notes.md']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test('write tools are the ones the guard judges', () => {
  assert.deepEqual([...WRITE_TOOLS].sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
});
