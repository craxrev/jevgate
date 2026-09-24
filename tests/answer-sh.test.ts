import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verdictText, matchFragment, type VerdictLine } from '../src/verdict.ts';

const SCRIPT = new URL('../hooks/answer.sh', import.meta.url).pathname;
const WARN = new URL('../hooks/warn.sh', import.meta.url).pathname;

/** answer.sh on one call: `lines` is the module's verdict (undefined: none written). */
function answer(mode: string | undefined, lines: VerdictLine[] | undefined, opts: { command?: string; judged?: string; id?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jevgate-answer-'));
  const data = join(home, '.claude', 'jevgate', 'run');
  mkdirSync(join(data, 'verdicts'), { recursive: true });
  const id = opts.id ?? 'toolu_01Abc';
  const command = opts.command ?? 'git push --force origin "main"\nsecond line é';
  if (lines) {
    writeFileSync(join(data, 'verdicts', id), verdictText(lines));
    writeFileSync(join(data, 'verdicts', `${id}.match`), matchFragment('Bash', { command: opts.judged ?? command })!);
  }
  const input = JSON.stringify({ session_id: 's', ...(mode ? { permission_mode: mode } : {}), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: id });
  const r = spawnSync('sh', [SCRIPT], { input, encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: '/elsewhere' } });
  assert.equal(r.status, 0);
  const out = r.stdout ? (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : undefined;
  return { decision: out?.permissionDecision, reason: out?.permissionDecisionReason, left: existsSync(join(data, 'verdicts', id)) };
}

const ask: VerdictLine[] = [{ mode: '*', kind: 'ask', reason: 'jevgate: asking · ships "x"' }, { mode: 'auto', kind: 'deny', reason: 'auto says no' }];

test('the line for the mode wins, else `*`; the verdict is used once', () => {
  assert.deepEqual(answer('auto', ask), { decision: 'deny', reason: 'auto says no', left: false });
  assert.deepEqual(answer('default', ask), { decision: 'ask', reason: 'jevgate: asking · ships "x"', left: false });
  assert.equal(answer('bypassPermissions', [{ mode: '*', kind: 'allow', reason: 'ok' }]).decision, 'allow');
});

test('free says nothing, in every mode', () => {
  for (const mode of ['auto', 'default', 'bypassPermissions', undefined]) assert.equal(answer(mode, [{ mode: '*', kind: 'free', reason: '' }]).decision, undefined);
});

test('no verdict, Jev down or no key: refused where nothing else judges, else left to Claude Code', () => {
  for (const lines of [undefined, [{ mode: '*', kind: 'unreachable', reason: 'down' }], [{ mode: '*', kind: 'nokey', reason: 'no key' }]] as (VerdictLine[] | undefined)[]) {
    assert.equal(answer('auto', lines).decision, undefined);
    assert.equal(answer('acceptEdits', lines).decision, undefined);
    assert.equal(answer('bypassPermissions', lines).decision, 'deny');
    assert.equal(answer('dontAsk', lines).decision, 'deny');
    assert.equal(answer(undefined, lines).decision, 'deny');
  }
  assert.match(answer('bypassPermissions', undefined).reason!, /did not judge this call/);
});

test('a gateway block asks where nothing else judges, else is left to Claude Code', () => {
  const blocked: VerdictLine[] = [{ mode: '*', kind: 'blocked', reason: 'blocked by gateway' }];
  assert.equal(answer('bypassPermissions', blocked).decision, 'ask');
  assert.equal(answer('auto', blocked).decision, undefined);
});

test('a call changed after it was judged gets no verdict', () => {
  const allow: VerdictLine[] = [{ mode: '*', kind: 'allow', reason: 'ok' }];
  assert.equal(answer('default', allow, { judged: 'ls' }).decision, undefined);
  assert.equal(answer('bypassPermissions', allow, { judged: 'ls' }).decision, 'deny');
  assert.equal(answer('default', allow, { judged: 'ls' }).left, false);
});

test('an id that is not a plain name finds no verdict', () => {
  assert.equal(answer('bypassPermissions', [{ mode: '*', kind: 'allow', reason: 'ok' }], { id: '../../etc' }).decision, 'deny');
});

test('warn.sh speaks only when function hooks are off', () => {
  const run = (v: string | undefined) => {
    const env = { ...process.env };
    if (v === undefined) delete env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
    else env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = v;
    return spawnSync('sh', [WARN], { input: '{}', encoding: 'utf8', env }).stdout;
  };
  assert.equal(run('1'), '');
  assert.equal(run('true'), '');
  assert.match(JSON.parse(run(undefined)).systemMessage, /function hooks are off/);
  assert.match(JSON.parse(run('0')).systemMessage, /nothing is guarded/);
});

const SLIPS = new URL('../hooks/slips.sh', import.meta.url).pathname;

test('a free call is noted for the slip check, with its transcript and tool', () => {
  const home = mkdtempSync(join(tmpdir(), 'jevgate-note-'));
  const data = join(home, '.claude', 'jevgate', 'run');
  mkdirSync(join(data, 'verdicts'), { recursive: true });
  writeFileSync(join(data, 'verdicts', 'toolu_F'), verdictText([{ mode: '*', kind: 'free', reason: '' }]));
  const input = JSON.stringify({ session_id: 'sess-1', transcript_path: '/t/s.jsonl', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_F' });
  spawnSync('sh', [SCRIPT], { input, encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: '/elsewhere' } });
  assert.equal(readFileSync(join(data, 'pending', 'sess-1'), 'utf8'), 'toolu_F\t/t/s.jsonl\tBash\t0\n');
});

test('slips.sh prints the free calls the classifier judged, keeps unwritten ones a few turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-slips-'));
  const t = join(dir, 's.jsonl');
  const result = (id: string, boundary: boolean) => JSON.stringify({ type: 'user', ...(boundary ? { classifierBoundary: true } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult: { stdout: '' } });
  writeFileSync(t, [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_A' }] } }), result('toolu_A', true), result('toolu_B', false)].join('\n') + '\n');
  const pending = join(dir, 'pending');
  writeFileSync(pending, `toolu_A\t${t}\tBash\t0\ntoolu_B\t${t}\tWrite\t0\ntoolu_C\t${t}\tBash\t3\ntoolu_D\t${t}\tBash\t4\n`);
  const r = spawnSync('sh', [SLIPS, pending], { encoding: 'utf8' });
  assert.equal(r.stdout, 'toolu_A\tBash\n');
  // C waits another turn, D gave up after five
  assert.equal(readFileSync(pending, 'utf8'), `toolu_C\t${t}\tBash\t4\n`);
  assert.equal(spawnSync('sh', [SLIPS, join(dir, 'none')], { encoding: 'utf8' }).stdout, '');
});
