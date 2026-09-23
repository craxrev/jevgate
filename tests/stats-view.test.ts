import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bar, spark, statsLines } from '../src/stats-view.ts';
import type { BashStats } from '../src/ui-model.ts';

const stats = (over: Partial<BashStats> = {}): BashStats => ({
  free: 22, allowed: 10, asked: 3, approved: 2, rejected: 1, blocked: 0, askedBy: [['deletes local_no_copy', 3]], denied: 4, unreachable: 0, categories: [['exfiltrates', 2], ['reads_secrets', 1]], avgMs: 900, msRecent: [800, 1200, 400], blocks: 0, agentDenies: 1, ...over,
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
  const lines = statsLines({ session: stats(), all: stats({ free: 173, allowed: 27 }), width: 44, entries: 400 });
  for (const l of lines) assert.ok(l.text.length <= 44, `${l.text.length}: ${l.text}`);
  assert.equal(lines[0]!.text, 'jevgate');
  assert.match(lines[2]!.text, /^This session · 39 calls$/);
  const allow = lines.find((l) => l.text.trimStart().startsWith('allow') && l.color)!;
  assert.equal(allow.color, 'green');
  assert.match(allow.text, / 10 +26%$/);
  const asked = lines.find((l) => l.text.trimStart().startsWith('asked') && l.color)!;
  assert.equal(asked.color, 'yellow');
  const denied = lines.find((l) => l.text.trimStart().startsWith('denied') && l.color)!;
  assert.ok(lines.some((l) => l.text.includes('asked   flagged, you decided')));
  assert.equal(denied.color, 'red');
  assert.ok(!lines.some((l) => l.text.trimStart().startsWith('unreachable')), 'zero unreachable is hidden');
  const chart = lines[lines.findIndex((l) => l.text === 'Jev latency') + 1]!;
  assert.equal(chart.text.length, 1 + 30, 'the chart spans the pane even with 3 calls');
  assert.match(chart.text, /^ ▁+\S{3}$/);
  assert.equal(chart.dimHead, 1 + 27, 'the empty stretch is drawn dim');
  assert.equal(lines[lines.findIndex((l) => l.text === 'Jev latency') + 2]!.text, ' last 3 calls · peak 1200ms');
  assert.equal(lines[lines.findIndex((l) => l.text === 'Your answers to asks') + 1]!.text, ' approved 2 · rejected 1');
  assert.ok(!lines.some((l) => l.text === 'Not judged by Jev'), 'hidden when Jev judged everything');
  assert.ok(lines.some((l) => l.text === 'Asked by flag · all-time'));
  assert.ok(lines.some((l) => l.text.includes('deletes local_no_copy') && l.color === 'yellow'));
  const fallback = statsLines({ session: stats({ unreachable: 2, blocked: 1 }), all: stats(), width: 44, entries: 1 });
  assert.ok(fallback.some((l) => l.text === ' handed to Claude Code 2 (Jev unreachable)'));
  assert.ok(fallback.some((l) => l.text === ' asked 1 (gateway blocked the request)'));
  assert.ok(lines.some((l) => l.text.includes('exfiltrates') && l.color === 'red'));
  assert.match(lines[lines.length - 2]!.text, /subagent ⇢1$/);
  assert.match(lines[lines.length - 1]!.text, /400 log entries · Esc closes/);
});

test('statsLines with nothing logged still renders', () => {
  const empty = stats({ free: 0, allowed: 0, asked: 0, approved: 0, rejected: 0, askedBy: [], denied: 0, categories: [], avgMs: 0, msRecent: [], agentDenies: 0 });
  const lines = statsLines({ session: empty, all: empty, width: 36, entries: 0 });
  assert.ok(lines.some((l) => l.text === 'Nothing denied yet'));
  assert.ok(lines.some((l) => l.text === ' no judged calls yet'));
  assert.ok(lines.every((l) => typeof l.text === 'string'));
});

test('spark scales to the 90th percentile, so one outlier does not flatten the rest', () => {
  const v = [600, 620, 580, 7586, 610, 1200, 600, 640, 590, 605];
  const line = spark(v);
  assert.equal(line.length, v.length);
  assert.equal(line[3], '█');
  assert.notEqual(line[0], '▁', 'a normal call keeps visible height');
  assert.equal(spark([]), '');
  assert.equal(spark([0, 0]), '');
});
