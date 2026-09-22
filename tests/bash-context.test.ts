import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherState, recentUserMessages, type Runner } from '../src/bash-context.ts';
import { parseShell } from '../src/shell.ts';

const line = (type: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { role: type, content: [{ type: 'text', text }] }, ...extra });

function transcript(...lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const fakeGit =
  (over: Partial<Record<string, string | undefined>> = {}): Runner =>
  (program, args) => {
    if (program !== 'git') return undefined;
    const key = args.join(' ');
    if (key in over) return over[key];
    if (key === 'rev-parse --show-toplevel') return '/repo\n';
    if (key === 'remote -v') return 'origin\tgit@github.com:me/repo.git (fetch)\norigin\tgit@github.com:me/repo.git (push)\n';
    if (key === 'status --porcelain') return ' M src/a.ts\n?? new.txt\n';
    return undefined;
  };

test('state carries the command as written, repo root and remotes', () => {
  const command = 'cd x && npm test 2>&1 | tail -5';
  const s = gatherState({ command, parsed: parseShell(command), cwd: '/repo/src', recentMessages: 5 }, fakeGit());
  assert.equal(s.command, command);
  assert.equal(s.cwd, '/repo/src');
  assert.equal(s.repo_root, '/repo');
  assert.match(s.remotes ?? '', /github\.com:me\/repo/);
  assert.equal(s.git_status, undefined); // npm test touches no files
  assert.equal(s.recent, undefined);
});

test('git status is gathered only for git, file writes, redirects and scripts', () => {
  for (const c of ['git checkout -- .', 'rm -rf build', 'echo x > f', "python3 - <<'EOF'\nx\nEOF"]) {
    const s = gatherState({ command: c, parsed: parseShell(c), cwd: '/repo', recentMessages: 0 }, fakeGit());
    assert.equal(s.git_status, ' M src/a.ts\n?? new.txt', c);
  }
  const clean = gatherState({ command: 'rm -rf build', parsed: parseShell('rm -rf build'), cwd: '/repo', recentMessages: 0 }, fakeGit({ 'status --porcelain': '' }));
  assert.equal(clean.git_status, '');
});

test('outside a repository only command and cwd are set', () => {
  const run: Runner = () => undefined;
  const s = gatherState({ command: 'rm -rf ~/x', parsed: parseShell('rm -rf ~/x'), cwd: '/Users/me', recentMessages: 0 }, run);
  assert.deepEqual(s, { command: 'rm -rf ~/x', cwd: '/Users/me' });
});

test('recent user messages: last n, oldest first, reminders skipped, long ones truncated', () => {
  const p = transcript(
    line('user', 'first ask'),
    line('assistant', 'ok'),
    line('user', '<system-reminder>ignored</system-reminder>'),
    line('user', 'second ask'),
    line('user', 'side', { isSidechain: true }),
    line('user', 'x'.repeat(2000)),
    line('user', 'third ask'),
  );
  assert.deepEqual(recentUserMessages(p, 2), ['x'.repeat(1500) + ' […]', 'third ask']);
  assert.deepEqual(recentUserMessages(p, 10), ['first ask', 'second ask', 'x'.repeat(1500) + ' […]', 'third ask']);
  assert.equal(recentUserMessages(p, 0), undefined);
  assert.equal(recentUserMessages('/nonexistent', 5), undefined);
  const s = gatherState({ command: 'ls', parsed: parseShell('ls'), transcriptPath: p, recentMessages: 1 }, () => undefined);
  assert.deepEqual(s.recent, ['third ask']);
});
