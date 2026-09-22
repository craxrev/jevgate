import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bar, spark, statsLines } from '../src/stats-view.ts';
import type { BashStats } from '../src/ui-model.ts';

const stats = (over: Partial<BashStats> = {}): BashStats => ({
  free: 22, ok: 28, allowed: 10, denied: 4, unreachable: 0, categories: [['exfiltrates', 2], ['reads_secrets', 1]], avgMs: 900, msRecent: [800, 1200, 400], blocks: 0, agentDenies: 1, ...over,
});

test('bar fills proportionally and clamps', () => {
  assert.equal(bar(1, 2, 10), '█████░░░░░');
  assert.equal(bar(0, 5, 4), '░░░░');
  assert.equal(bar(5, 0, 4), '░░░░');
  assert.equal(bar(9, 5, 4), '████');
  assert.equal(bar(1, 1, 0), '');
});

test('spark scales to the highest value', () => {
  assert.equal(spark([0, 50, 100]), '▁▄█');
  assert.equal(spark([]), '');
  assert.equal(spark([0, 0]), '');
  assert.equal(spark([5]).length, 1);
});

test('statsLines fits the pane width and carries the styles', () => {
  const lines = statsLines({ session: stats(), all: stats({ free: 173, ok: 53, allowed: 27 }), width: 44, entries: 400 });
  for (const l of lines) assert.ok(l.text.length <= 44, `${l.text.length}: ${l.text}`);
  assert.equal(lines[0]!.text, 'jevgate');
  assert.match(lines[2]!.text, /^This session · 54 calls$/);
  const allow = lines.find((l) => l.text.trimStart().startsWith('allow') && l.color)!;
  assert.equal(allow.color, 'green');
  assert.match(allow.text, / 10 +19%$/);
  const denied = lines.find((l) => l.text.trimStart().startsWith('denied') && l.color)!;
  assert.ok(lines.some((l) => l.text.includes('unsure  Claude Code decided')));
  assert.equal(denied.color, 'red');
  assert.ok(!lines.some((l) => l.text.trimStart().startsWith('unreachable')), 'zero unreachable is hidden');
  const avoided = lines[lines.findIndex((l) => l.text === 'Classifier passes avoided') + 2]!;
  assert.match(avoided.text, /14 of 32 judged/);
  assert.ok(lines.some((l) => l.text.includes('exfiltrates') && l.color === 'red'));
  assert.match(lines[lines.length - 2]!.text, /subagent ⇢1$/);
  assert.match(lines[lines.length - 1]!.text, /400 log entries · Esc closes/);
});

test('statsLines with nothing logged still renders', () => {
  const empty = stats({ free: 0, ok: 0, allowed: 0, denied: 0, categories: [], avgMs: 0, msRecent: [], agentDenies: 0 });
  const lines = statsLines({ session: empty, all: empty, width: 36, entries: 0 });
  assert.ok(lines.some((l) => l.text === 'Nothing denied yet'));
  assert.ok(lines.every((l) => typeof l.text === 'string'));
});
