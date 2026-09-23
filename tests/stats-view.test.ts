import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bar, meanTiming, spark, statsLines, timingBar } from '../src/stats-view.ts';
import type { BashStats } from '../src/ui-model.ts';

const stats = (over: Partial<BashStats> = {}): BashStats => ({
  free: 22, allowed: 10, asked: 3, approved: 2, rejected: 1, blocked: 0, askedBy: [['deletes local_no_copy', 3]], denied: 4, unreachable: 0, categories: [['exfiltrates', 2], ['reads_secrets', 1]], avgMs: 900, msRecent: [800, 1200, 400], timingRecent: [undefined, undefined, undefined], blocks: 0, agentDenies: 1, ...over,
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
  assert.ok(lines.some((l) => l.text.includes('asked      flagged, you decided')));
  assert.equal(denied.color, 'red');
  assert.ok(!lines.some((l) => l.text.trimStart().startsWith('passed on')), 'nothing passed on is hidden');
  const passed = statsLines({ session: stats({ unreachable: 2 }), all: stats(), width: 44, entries: 400 });
  const unr = passed.find((l) => l.text.startsWith(' passed on ') && l.color)!;
  assert.match(unr.text, /^ passed on  █/, 'two spaces between the longest label and its bar');
  assert.ok(passed.some((l) => l.text === ' passed on  no verdict, left to Claude Code'));
  assert.equal(unr.color, 'claude');
  assert.notEqual(unr.color, asked.color, 'unreachable does not read as asked');
  const chart = lines[lines.findIndex((l) => l.text === 'Jev latency') + 1]!;
  assert.equal(chart.text.length, 1 + 30, 'the chart spans the pane even with 3 calls');
  assert.match(chart.text, /^ ▁+\S{3}$/);
  assert.equal(chart.dimHead, 1 + 27, 'the empty stretch is drawn dim');
  assert.equal(lines[lines.findIndex((l) => l.text === 'Jev latency') + 2]!.text, ' last 3 calls · peak 1200ms');
  assert.equal(lines[lines.findIndex((l) => l.text === 'Your answers to asks') + 1]!.text, ' approved 2 · rejected 1');
  assert.ok(lines.some((l) => l.text === 'Asked by flag · all-time'));
  assert.ok(lines.some((l) => l.text.includes('deletes local_no_copy') && l.color === 'yellow'));
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

const tm = (ms: number, prep: number, connect: number, server?: number) => ({ ms, prep, connect, server, answered: server !== undefined, tries: server !== undefined ? 1 : 2 });

test('timingBar draws the parts in order, scaled to the shared max', () => {
  const segs = timingBar(tm(1000, 100, 100, 500), 1000, 20);
  assert.deepEqual(segs.map((g) => g.text.length), [2, 2, 6, 10]);
  assert.deepEqual(segs.map((g) => g.color), [undefined, 'blue', 'magenta', 'cyan']);
  assert.equal(timingBar(tm(500, 100, 100, 200), 1000, 20).map((g) => g.text).join('').length, 10, 'half the max, half the width');
});

test('an unanswered call ends in a dotted wait', () => {
  const segs = timingBar(tm(8000, 200, 100), 8000, 40);
  assert.equal(segs.at(-1)!.text[0], '·');
  assert.equal(segs.map((g) => g.text).join('').length, 40);
});

test('meanTiming averages answered calls only', () => {
  assert.equal(meanTiming([tm(8000, 0, 0)]), undefined);
  assert.deepEqual(meanTiming([tm(400, 100, 80, 70), tm(600, 100, 80, 270), tm(8000, 0, 0)]), { ms: 500, prep: 100, connect: 80, server: 170, answered: true, tries: 1 });
});

test('the pane shows where the time goes for the last call and the average', () => {
  const lines = statsLines({ session: stats({ msRecent: [400, 600], timingRecent: [tm(400, 100, 80, 70), tm(600, 100, 80, 270)], lastCall: tm(8132, 150, 90) }), all: stats(), width: 60, entries: 5 });
  const text = lines.map((l) => l.text);
  const i = text.indexOf('Where the time goes');
  assert.ok(i > text.indexOf('Jev latency'));
  assert.match(text[i + 1]!, /^ last\s+8132ms /);
  assert.match(text[i + 2]!, /^ avg\s+500ms /);
  assert.ok(text.includes(' last call: Jev did not answer (2 tries)'));
  assert.ok(text.includes(' avg of the last 2 answered calls'));
  assert.ok(lines[i + 1]!.segments!.length > 1);
  const none = statsLines({ session: stats(), all: stats(), width: 60, entries: 5 }).map((l) => l.text);
  assert.ok(!none.includes('Where the time goes'), 'hidden until a call has timings');
});
