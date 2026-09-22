// tests/fixtures/commands.jsonl: real commands from the author's sessions,
// sanitized (home paths, work projects and secret-looking strings removed),
// stratified by the analyze2 bucket. The live probe reads the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShell } from '../src/shell.ts';
import { checkFree } from '../src/free.ts';
import { needsGitStatus } from '../src/bash-policy.ts';

type Row = { cmd: string; bucket: string };
const rows: Row[] = readFileSync(new URL('./fixtures/commands.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('{'))
  .map((l) => JSON.parse(l) as Row);

test('the corpus is present and sanitized', () => {
  assert.ok(rows.length >= 100, `only ${rows.length} rows`);
  for (const r of rows) {
    assert.doesNotMatch(r.cmd, /\/Users\//, r.cmd.slice(0, 80));
    assert.doesNotMatch(r.cmd, /(hf_|sk-|ghp_)[A-Za-z0-9]{10,}/, r.cmd.slice(0, 80));
  }
});

test('every corpus command parses without throwing', () => {
  for (const r of rows) {
    const p = parseShell(r.cmd);
    assert.ok(p.segments.length > 0 || p.scripts.length > 0 || p.syntax.length > 0, r.cmd.slice(0, 80));
    checkFree(r.cmd);
    needsGitStatus(p);
  }
});

test('the free share of the corpus stays in the measured band', () => {
  // 23.4% of all calls were FREE in the 105-session analysis; the fixture is stratified, not proportional
  const free = rows.filter((r) => checkFree(r.cmd).free).length;
  const share = free / rows.length;
  assert.ok(share > 0.05 && share < 0.4, `free share ${share.toFixed(2)}`);
});

test('nothing outside the FREE bucket is free, except analyze2 misparses of quoted operators', () => {
  const looser = rows.filter((r) => r.bucket !== 'FREE' && checkFree(r.cmd).free);
  for (const r of looser) {
    // analyze2 saw a `>` or `(` inside quotes, or a stash list / docker ps it does not know
    const p = parseShell(r.cmd);
    assert.ok(
      p.segments.every((s) => ['echo', 'ls', 'cat', 'head', 'tail', 'grep', 'sed', 'find', 'git', 'wc', 'sort', 'cd', 'printf', 'docker', 'pgrep', 'lsof', 'claude', 'xargs', 'du', 'file', 'which', 'tr', 'cut', 'diff', 'sleep', 'stat', 'pwd', 'true', 'realpath', 'basename', 'dirname', 'nl', 'cmp', 'uname', 'rg', 'fd', 'date', 'hostname', 'ps', 'tree'].includes(s.program)),
      r.cmd.slice(0, 100),
    );
  }
});
