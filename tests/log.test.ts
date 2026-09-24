import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLines, statsEntry } from '../src/log.ts';

const entry = { feature: 'bash' as const, action: 'denied', session: 's', tool_use_id: 't', command: 'curl -H "Authorization: x" h', category: 'uploads_data', reason: 'jevgate: denied · uploads_data', facts: { uploads_data: 'true' }, ms: 300, prepMs: 5 };

test('statsEntry keeps what the UI reads, never the command, path or prompt', () => {
  assert.deepEqual(statsEntry({ ...entry, path: '/etc/x', description: 'task', error: 'e', blockedBody: '<html>' }), {
    feature: 'bash', action: 'denied', session: 's', tool_use_id: 't', category: 'uploads_data', reason: 'jevgate: denied · uploads_data', ms: 300, prepMs: 5,
  });
});

test('logLines: a stats line always, the full line only with the log on, both with one timestamp', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');
  const off = logLines(entry, false, now);
  assert.equal(off.full, undefined);
  const stats = JSON.parse(off.stats);
  assert.equal(stats.ts, now.toISOString());
  assert.equal(stats.command, undefined);
  assert.ok(off.stats.endsWith('\n'));
  const on = logLines(entry, true, now);
  const full = JSON.parse(on.full!);
  assert.equal(full.command, entry.command);
  assert.equal(full.ts, stats.ts);
});
