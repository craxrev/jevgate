import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherState, recentTurns, type Runner } from '../src/bash-context.ts';
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
    if (key === 'branch --show-current') return 'feat/x\n';
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return 'origin/feat/x\n';
    return undefined;
  };

test('state carries the command as written, repo root and remotes', async () => {
  const command = 'cd x && npm test 2>&1 | tail -5';
  const s = await gatherState({ command, parsed: parseShell(command), cwd: '/repo/src', recentTurns: 5 }, fakeGit());
  assert.equal(s.command, command);
  assert.equal(s.cwd, '/repo/src');
  assert.equal(s.repo_root, '/repo');
  assert.match(s.remotes ?? '', /github\.com:me\/repo/);
  assert.equal(s.git_status, undefined); // npm test touches no files
  assert.equal(s.recent, undefined);
  assert.equal(s.current_branch, 'feat/x');
  assert.equal(s.branch_pushed, true);
  const unpushed = await gatherState({ command, parsed: parseShell(command), cwd: '/repo', recentTurns: 0, home: '/Users/me', knownHosts: ['box'] }, fakeGit({ 'rev-parse --abbrev-ref --symbolic-full-name @{u}': undefined }));
  assert.equal(unpushed.branch_pushed, false);
  assert.equal(unpushed.home, '/Users/me');
  assert.deepEqual(unpushed.known_hosts, ['box']);
});

test('git status is gathered only for git, file writes, redirects and scripts', async () => {
  for (const c of ['git checkout -- .', 'rm -rf build', 'echo x > f', "python3 - <<'EOF'\nx\nEOF"]) {
    const s = await gatherState({ command: c, parsed: parseShell(c), cwd: '/repo', recentTurns: 0 }, fakeGit());
    assert.equal(s.git_status, ' M src/a.ts\n?? new.txt', c);
  }
  const clean = await gatherState({ command: 'rm -rf build', parsed: parseShell('rm -rf build'), cwd: '/repo', recentTurns: 0 }, fakeGit({ 'status --porcelain': '' }));
  assert.equal(clean.git_status, '');
});

test('outside a repository only command and cwd are set', async () => {
  const run: Runner = () => undefined;
  const s = await gatherState({ command: 'rm -rf ~/x', parsed: parseShell('rm -rf ~/x'), cwd: '/Users/me', recentTurns: 0 }, run);
  assert.deepEqual(s, { command: 'rm -rf ~/x', cwd: '/Users/me' });
});

test('recent turns: last n of both roles, oldest first, reminders skipped, long ones truncated', async () => {
  const p = transcript(
    line('user', 'first ask'),
    line('assistant', 'Done. Commit it?'),
    line('user', '<system-reminder>ignored</system-reminder>'),
    line('user', 'yes, commit it'),
    line('user', 'side', { isSidechain: true }),
    line('assistant', 'x'.repeat(2000)),
    line('user', 'third ask'),
  );
  assert.deepEqual(recentTurns(p, 2), [{ role: 'assistant', text: 'x'.repeat(1500) + ' […]' }, { role: 'user', text: 'third ask' }]);
  assert.deepEqual(
    recentTurns(p, 10)!.map((t) => `${t.role}: ${t.text.slice(0, 16)}`),
    ['user: first ask', 'assistant: Done. Commit it?', 'user: yes, commit it', 'assistant: xxxxxxxxxxxxxxxx', 'user: third ask'],
  );
  assert.equal(recentTurns(p, 0), undefined);
  assert.equal(recentTurns('/nonexistent', 5), undefined);
  const s = await gatherState({ command: 'ls', parsed: parseShell('ls'), transcriptPath: p, recentTurns: 1 }, () => undefined);
  assert.deepEqual(s.recent, [{ role: 'user', text: 'third ask' }]);
});

test('the git calls run at once, not one after another', async () => {
  const slow: Runner = (program, args, cwd) => new Promise((r) => setTimeout(() => r(fakeGit()(program, args, cwd) as string | undefined), 40));
  const t = performance.now();
  const s = await gatherState({ command: 'rm -rf build', parsed: parseShell('rm -rf build'), cwd: '/repo', recentTurns: 0 }, slow);
  assert.ok(performance.now() - t < 120, 'five 40ms calls took longer than two of them');
  assert.equal(s.repo_root, '/repo');
  assert.equal(s.branch_pushed, true);
  assert.equal(s.git_status, ' M src/a.ts\n?? new.txt');
});

test('outside a repository the failed git calls leave nothing behind', async () => {
  const s = await gatherState({ command: 'rm -rf build', parsed: parseShell('rm -rf build'), cwd: '/tmp', recentTurns: 0 }, (_p, args) => (args[0] === 'remote' ? 'stray\n' : undefined));
  assert.deepEqual(Object.keys(s).sort(), ['command', 'cwd']);
});
