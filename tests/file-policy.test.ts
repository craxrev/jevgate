import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolPath,
  contentHead,
  resolvePath,
  insideProject,
  isSensitivePath,
  decideFile,
  DEFAULT_FILE_THRESHOLDS,
  FILE_QUESTIONS,
  FILE_CATEGORIES,
  WRITE_TOOLS,
} from '../src/file-policy.ts';
import type { JevResponse } from '../src/jev.ts';

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

test('insideProject: repo root, cwd fallback, scratchpad', () => {
  assert.equal(insideProject(`${REPO}/src/a.ts`, REPO, `${REPO}/src`), true);
  assert.equal(insideProject(REPO, REPO, REPO), true);
  assert.equal(insideProject('/Users/me/dev/repo-other/a.ts', REPO, REPO), false);
  assert.equal(insideProject('/Users/me/.zshrc', REPO, REPO), false);
  assert.equal(insideProject('/Users/me/notes/a.md', undefined, '/Users/me/notes'), true);
  assert.equal(insideProject('/Users/me/other/a.md', undefined, '/Users/me/notes'), false);
  assert.equal(insideProject('/private/tmp/claude-501/-Users-me-dev-repo/abc/scratchpad/x.txt', REPO, REPO), true);
  assert.equal(insideProject('/tmp/claude/x.txt', REPO, REPO), true);
  assert.equal(insideProject('/tmp/x.txt', REPO, REPO), false);
});

test('isSensitivePath matches credential files, not ordinary ones', () => {
  for (const p of ['/Users/me/.ssh/id_rsa', '/Users/me/dev/repo/.env', '/Users/me/dev/repo/.env.local', '/Users/me/.aws/credentials', '/Users/me/.claude/settings.json', '/x/key.pem']) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ['/Users/me/dev/repo/src/env.ts', '/Users/me/dev/repo/.env.example', '/Users/me/.claude/skills/foo/SKILL.md', '/Users/me/notes.md']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

const res = (over: Partial<Record<(typeof FILE_CATEGORIES)[number], number>>): JevResponse => {
  const answers: JevResponse['answers'] = {};
  for (const c of FILE_CATEGORIES) answers[c] = { type: 'noul', noul: over[c] ?? 0.05 };
  return { model: 'j', answers };
};

test('decideFile denies system changes at the threshold, exceeds_request is log-only by default', () => {
  assert.equal(decideFile(res({}), DEFAULT_FILE_THRESHOLDS).action, 'ok');
  const d = decideFile(res({ changes_system_or_user_config: 0.6 }), DEFAULT_FILE_THRESHOLDS);
  assert.equal(d.action, 'deny');
  if (d.action === 'deny') assert.equal(d.reason, 'jevgate: denied, changes_system_or_user_config 0.60 (threshold 0.60)');
  assert.equal(decideFile(res({ exceeds_request: 0.99 }), DEFAULT_FILE_THRESHOLDS).action, 'ok');
  assert.equal(decideFile(res({ exceeds_request: 0.99 }), { ...DEFAULT_FILE_THRESHOLDS, exceeds_request: 0.8 }).action, 'deny');
});

test('questions cover both categories and name the state fields', () => {
  assert.deepEqual(Object.keys(FILE_QUESTIONS), [...FILE_CATEGORIES]);
  for (const c of FILE_CATEGORIES) assert.match(FILE_QUESTIONS[c]!.instructions, /`path`/);
  assert.match(FILE_QUESTIONS.exceeds_request!.instructions, /`recent`/);
  assert.deepEqual([...WRITE_TOOLS].sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
});
