import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger, seedStats, statsEntry } from '../src/log.ts';

const lines = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const mode = (p: string) => statSync(p).mode & 0o777;
const entry = { feature: 'bash' as const, action: 'denied', session: 's', tool_use_id: 't', command: 'curl -H "Authorization: x" h', category: 'uploads_data', reason: 'jevgate: denied · uploads_data', facts: { uploads_data: 'true' }, ms: 300, prepMs: 5 };

test('statsEntry keeps what the UI reads, never the command, path or prompt', () => {
  assert.deepEqual(statsEntry({ ...entry, path: '/etc/x', description: 'task', error: 'e', blockedBody: '<html>' }), {
    feature: 'bash', action: 'denied', session: 's', tool_use_id: 't', category: 'uploads_data', reason: 'jevgate: denied · uploads_data', ms: 300, prepMs: 5,
  });
});

test('log off: stats.jsonl only, owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-log-'));
  logger({ CLAUDE_PLUGIN_DATA: dir }, { log: false })(entry);
  assert.equal(existsSync(join(dir, 'decisions-v2.jsonl')), false);
  const [s] = lines(join(dir, 'stats.jsonl'));
  assert.equal(s!.command, undefined);
  assert.equal(s!.action, 'denied');
  assert.equal(typeof s!.ts, 'string');
  assert.equal(mode(join(dir, 'stats.jsonl')), 0o600);
  assert.equal(mode(join(dir, 'ui.jsonl')), 0o600);
});

test('log on: the full entry too, at logPath when set, same ts as its stats line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-log-'));
  logger({ CLAUDE_PLUGIN_DATA: dir }, { log: true })(entry);
  const [full] = lines(join(dir, 'decisions-v2.jsonl'));
  assert.equal(full!.command, entry.command);
  assert.equal(full!.ts, lines(join(dir, 'stats.jsonl'))[0]!.ts);
  assert.equal(mode(join(dir, 'decisions-v2.jsonl')), 0o600);
  const custom = join(dir, 'elsewhere.jsonl');
  logger({ CLAUDE_PLUGIN_DATA: dir }, { log: true, logPath: custom })(entry);
  assert.equal(lines(custom).length, 1);
  assert.equal(lines(join(dir, 'stats.jsonl')).length, 2);
});

test('the first write seeds stats.jsonl from the old full log, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevgate-log-'));
  const old = join(dir, 'decisions-v2.jsonl');
  writeFileSync(old, JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ...entry }) + '\n{partial\n' + JSON.stringify({ ts: '2026-01-02T00:00:00.000Z', feature: 'compact', action: 'verbatim', session: 's', ratio: 0.5 }) + '\n', { mode: 0o644 });
  const log = logger({ CLAUDE_PLUGIN_DATA: dir }, { log: false });
  log({ feature: 'bash', action: 'free', session: 's' });
  log({ feature: 'bash', action: 'allow', session: 's' });
  seedStats(dir);
  const s = lines(join(dir, 'stats.jsonl'));
  assert.deepEqual(s.map((l) => l.action), ['denied', 'verbatim', 'free', 'allow']);
  assert.equal(s[0]!.ts, '2026-01-01T00:00:00.000Z');
  assert.equal(s[0]!.command, undefined);
  assert.equal(s[1]!.ratio, undefined);
  assert.equal(mode(old), 0o600);
});
