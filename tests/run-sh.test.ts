import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RUN = new URL('../hooks/run.sh', import.meta.url).pathname;

function run(mode: string, gate: string, stdin = '{}') {
  const data = mkdtempSync(join(tmpdir(), 'jevgate-run-'));
  const r = spawnSync('sh', [RUN, mode, gate], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_LOGPATH: '/dev/null' } });
  const log = join(data, 'hook-errors.log');
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('a gate that answers passes its exit code and stdout through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-gate-'));
  const ok = join(dir, 'ok.ts');
  writeFileSync(ok, "process.stdout.write('{\"x\":1}');\n");
  const r = run('closed', ok);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"x":1}');
  assert.equal(r.log, '');
  const two = join(dir, 'two.ts');
  writeFileSync(two, "process.stderr.write('blocked by gate');\nprocess.exit(2);\n");
  const r2 = run('closed', two);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /blocked by gate/);
  assert.match(r2.log, /two\.ts exit 2\nblocked by gate/);
});

test('a gate that cannot load blocks in closed mode and is silent in open mode, both logged', () => {
  const missing = '/nonexistent/jevgate/gate.ts';
  const closed = run('closed', missing);
  assert.equal(closed.code, 2);
  assert.match(closed.stderr, /refusing to run unguarded/);
  assert.match(closed.log, /gate\.ts exit 1\n[\s\S]*Cannot find module/);
  const open = run('open', missing);
  assert.equal(open.code, 0);
  assert.equal(open.stdout, '');
  assert.match(open.log, /Cannot find module/);
});

test('the real gates load through the wrapper', () => {
  for (const gate of ['bash-gate', 'file-gate', 'agent-gate', 'done-check']) {
    const r = run('closed', new URL(`../hooks/${gate}.ts`, import.meta.url).pathname);
    assert.equal(r.code, 0, `${gate}: ${r.stderr}`);
  }
});
