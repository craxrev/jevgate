import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeBash, judgeFile, type GateHost } from '../src/gate.ts';
import { DEFAULTS } from '../src/config.ts';
import type { FetchLike } from '../src/jev.ts';
import type { Runner } from '../src/bash-context.ts';

const choice = (p: Record<string, number>) => ({ type: 'choice', choice: Object.keys(p)[0], probabilities: p, confidence: 0.5 });
const noul = (n: number) => ({ type: 'noul', noul: n });
const quiet = {
  deletes: choice({ none: 0.97, local_no_copy: 0.02, remote: 0.01 }),
  ships: choice({ none: 0.98, live_reversible: 0.01, public_permanent: 0.01 }),
  changes_system: noul(0.03),
  rewrites_history: noul(0.02),
  uploads_data: noul(0.04),
  exposes_secret: noul(0.02),
  requested: noul(0.95),
};
const jev = (over: Record<string, unknown> = {}): FetchLike => async () => ({ status: 200, ok: true, text: JSON.stringify({ model: 'j', answers: { ...quiet, ...over } }) });
const git: Runner = (_p, args) => (args.join(' ') === 'rev-parse --show-toplevel' ? '/repo\n' : undefined);

function host(over: Partial<GateHost> = {}): GateHost & { sent: unknown[] } {
  const sent: unknown[] = [];
  const base: GateHost = {
    cfg: DEFAULTS,
    apiKey: 'k',
    run: git,
    fetch: jev(),
    exists: async () => false,
    rulesFile: async () => undefined,
    turns: async () => [{ role: 'user', text: 'clean up the build dir' }],
    cwd: '/repo',
    roots: ['/repo'],
    home: '/Users/me',
    timed: (p) => p,
  };
  const h = { ...base, ...over };
  const f = h.fetch;
  return { ...h, fetch: (url, init) => (sent.push(JSON.parse(init.body)), f(url, init)), sent };
}
const ids = { session: 's', tool_use_id: 'toolu_1' };

test('a free command is not sent to Jev', async () => {
  const h = host();
  const out = await judgeBash('git status', ids, h);
  assert.deepEqual(out.lines, [{ mode: '*', kind: 'free', reason: '' }]);
  assert.equal(out.log?.action, 'free');
  assert.equal(h.sent.length, 0);
});

test('a clean command is allowed, with the conversation in what Jev sees', async () => {
  const h = host();
  const out = await judgeBash('rm -rf build', ids, h);
  assert.deepEqual(out.lines, [{ mode: '*', kind: 'allow', reason: 'jevgate: nothing flagged' }]);
  assert.equal(out.log?.action, 'allow');
  assert.equal(out.log?.command, 'rm -rf build');
  const state = (h.sent[0] as { state: { recent: unknown; repo_root: string } }).state;
  assert.deepEqual(state.recent, [{ role: 'user', text: 'clean up the build dir' }]);
  assert.equal(state.repo_root, '/repo');
});

test('a flagged command asks; the rules file adds a line for each mode it overrides', async () => {
  const h = host({ fetch: jev({ deletes: choice({ local_no_copy: 0.9, none: 0.05, remote: 0.05 }) }), rulesFile: async () => ({ modes: { auto: { deletes: { local_no_copy: 'deny' } } } }) });
  const out = await judgeBash('rm -rf ~/notes', ids, h);
  assert.deepEqual(out.lines.map((l) => [l.mode, l.kind]), [['*', 'ask'], ['auto', 'deny']]);
  assert.equal(out.log?.action, 'asked');
  assert.equal(out.log?.category, 'deletes local_no_copy');
});

test('Jev down, a gateway block and no key are no verdict, left to answer.sh', async () => {
  const down = await judgeBash('rm -rf build', ids, host({ fetch: async () => { throw new Error('ECONNRESET'); } }));
  assert.equal(down.lines[0]!.kind, 'unreachable');
  assert.equal(down.log?.action, 'unreachable');
  const blocked = await judgeBash('rm -rf build', ids, host({ fetch: async () => ({ status: 403, ok: false, text: '<html>blocked</html>', headers: { server: 'envoy' } }) }));
  assert.equal(blocked.lines[0]!.kind, 'blocked');
  assert.equal(blocked.log?.category, 'blocked');
  assert.deepEqual(blocked.log?.blockedHeaders, { server: 'envoy' });
  const timedOut = await judgeBash('rm -rf build', ids, host({ timed: () => Promise.reject(new Error('Jev did not answer within 4000ms')) }));
  assert.equal(timedOut.lines[0]!.kind, 'unreachable');
  assert.equal((await judgeBash('rm -rf build', ids, host({ apiKey: undefined }))).lines[0]!.kind, 'nokey');
});

test('a disabled guard judges nothing and logs nothing', async () => {
  const out = await judgeBash('rm -rf /', ids, host({ cfg: { ...DEFAULTS, bashEnabled: false } }));
  assert.deepEqual(out, { lines: [{ mode: '*', kind: 'free', reason: '' }] });
});

test('file guard: a secret read is refused locally, other reads and in-project writes are free', async () => {
  const h = host();
  const secret = await judgeFile('Read', { file_path: '~/.ssh/id_ed25519' }, ids, h);
  assert.equal(secret.lines[0]!.kind, 'deny');
  assert.equal(secret.log?.path, '/Users/me/.ssh/id_ed25519');
  assert.deepEqual((await judgeFile('Read', { file_path: 'src/a.ts' }, ids, h)).lines[0]!.kind, 'free');
  const inside = await judgeFile('Write', { file_path: 'src/a.ts', content: 'x' }, ids, h);
  assert.equal(inside.lines[0]!.kind, 'free');
  assert.equal(h.sent.length, 0);
});

test('file guard: a write outside the project is judged, with whether the file exists', async () => {
  const h = host({ exists: async (p) => p === '/etc/hosts' });
  const out = await judgeFile('Write', { file_path: '/etc/hosts', content: '127.0.0.1 x' }, ids, h);
  assert.equal(out.lines[0]!.kind, 'allow');
  const state = (h.sent[0] as { state: { exists: boolean; content_head: string; path: string } }).state;
  assert.equal(state.exists, true);
  assert.equal(state.path, '/etc/hosts');
  assert.equal(state.content_head, '127.0.0.1 x');
});

test('a read-only command outside the session folder is judged, as Claude Code would send it to its classifier', async () => {
  const h = host();
  assert.equal((await judgeBash('cat /tmp/x.txt', ids, h)).lines[0]!.kind, 'allow');
  assert.equal(h.sent.length, 1);
  assert.equal((await judgeBash('cat src/a.ts', ids, h)).lines[0]!.kind, 'free');
  assert.equal(h.sent.length, 1);
});

test('file guard: a write to the repo root from a subfolder session is judged', async () => {
  const h = host({ cwd: '/repo/sub', roots: ['/repo/sub'] });
  assert.equal((await judgeFile('Write', { file_path: '../root.txt', content: 'x' }, ids, h)).lines[0]!.kind, 'allow');
  assert.equal(h.sent.length, 1);
  const own = await judgeFile('Write', { file_path: '/private/tmp/claude-501/-repo-sub/s/scratchpad/n.txt', content: 'x' }, ids, h);
  assert.equal(own.lines[0]!.kind, 'free');
});
