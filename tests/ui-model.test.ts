import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, tally, statusText, footerLabel, bashRowText, groupSummary, kb, bashStats, latestSession, formatStats } from '../src/ui-model.ts';

const scores = (over: Record<string, number>) => ({
  destroys_uncommitted_work: 0.02, deletes_outside_repo: 0.02, rewrites_shared_history: 0.02, deploys_or_publishes: 0.02,
  exfiltrates: 0.02, reads_secrets: 0.02, escalates_or_system: 0.02, exceeds_request: 0.1, ...over,
});

const log = [
  { ts: 't', feature: 'bash', action: 'free', session: 's1', tool_use_id: 'a', command: 'git status' },
  { ts: 't', feature: 'bash', action: 'ok', session: 's1', tool_use_id: 'b', scores: scores({ reads_secrets: 0.13 }), ms: 340 },
  { ts: 't', feature: 'bash', action: 'allow', session: 's1', tool_use_id: 'g', scores: scores({ reads_secrets: 0.11 }), ms: 300 },
  { ts: 't', feature: 'bash', action: 'denied', session: 's1', tool_use_id: 'c', category: 'exfiltrates', reason: 'jevgate: denied, exfiltrates 0.98 (threshold 0.60)', scores: scores({ exfiltrates: 0.98, reads_secrets: 0.95 }), ms: 880 },
  { ts: 't', feature: 'bash', action: 'unreachable', session: 's1', tool_use_id: 'd', error: 'Jev HTTP 401', ms: 830 },
  { ts: 't', feature: 'bash', action: 'fast-lane', session: 's0', tool_use_id: 'e', scores: { read_only: 0.97, dev_task: 0.02, unsafe: 0.02 }, ms: 300 },
  { ts: 't', feature: 'bash', action: 'not-asked', reason: 'file-write', session: 's0', tool_use_id: 'f', command: 'rm x' },
  { ts: 't', feature: 'bash', action: 'asked', session: 's1', tool_use_id: 'h', category: 'deletes local_no_copy', facts: { deletes: 'local_no_copy' }, scores: {}, ms: 410 },
  { ts: 't', feature: 'bash', action: 'allow', session: 's1', tool_use_id: 'i', facts: { deletes: 'none' }, scores: {}, ms: 350 },
  { ts: 't', feature: 'done', action: 'block', session: 's1' },
  { ts: 't', feature: 'agent', action: 'deny', session: 's2' },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

test('parseLog skips junk lines', () => {
  assert.equal(parseLog('garbage\n' + log + '\n{bad').length, 11);
});

test('tally counts per session; free is counted apart, unreachable is a deny, old names fold into ok', () => {
  assert.deepEqual(tally(parseLog(log), 's1'), { free: 1, ok: 3, asked: 1, denied: 2, blocks: 1, agentDenies: 0 });
  assert.deepEqual(tally(parseLog(log), 's0'), { free: 1, ok: 1, asked: 0, denied: 0, blocks: 0, agentDenies: 0 });
  assert.equal(tally(parseLog(log), 's2').agentDenies, 1);
});

test('statusText is compact and empty when nothing happened', () => {
  assert.equal(statusText({ free: 9, ok: 0, asked: 0, denied: 0, blocks: 0, agentDenies: 0 }, 0), undefined);
  assert.equal(statusText({ free: 9, ok: 3, asked: 2, denied: 1, blocks: 0, agentDenies: 2 }, 2), 'jev ✓3 ok · ?2 asked · ⊘1 denied · ⇢2 subagent · ⇊2 compact');
});

test('footerLabel is the short form; free commands do not show', () => {
  assert.equal(footerLabel({ free: 4, ok: 0, asked: 0, denied: 0, blocks: 0, agentDenies: 0 }, 0), undefined);
  assert.equal(footerLabel({ free: 9, ok: 5, asked: 1, denied: 2, blocks: 1, agentDenies: 1 }, 1), 'jev ✓5 ?1 ⊘2 ✗1 ⇢1 ⇊1');
});

test('bashRowText: ok shows the top two scores, denied the category and score, free nothing', () => {
  const [free, ok, allow, denied, unreachable, legacy] = parseLog(log);
  assert.equal(bashRowText(free!), undefined);
  assert.equal(bashRowText(ok!), '▸ jevgate unsure · reads_secrets 0.13, exceeds_request 0.10 · 340ms');
  assert.equal(bashRowText(allow!), '▸ jevgate allow · reads_secrets 0.11, exceeds_request 0.10 · 300ms');
  assert.equal(bashRowText(denied!), '✗ jevgate denied · exfiltrates 0.98');
  assert.match(bashRowText(unreachable!)!, /unreachable.*830ms/);
  assert.equal(bashRowText(legacy!), undefined);
  const [, , , , , , , asked, factAllow] = parseLog(log);
  assert.equal(bashRowText(asked!), '? jevgate asked · deletes local_no_copy · 410ms');
  assert.equal(bashRowText(factAllow!), '▸ jevgate allow · nothing flagged · 350ms');
  assert.equal(bashRowText({ ts: 't', feature: 'bash', action: 'asked', category: 'blocked', ms: 90 }), '? jevgate asked · Jev could not judge (gateway block) · 90ms');
  assert.equal(bashRowText({ ts: 't', feature: 'file', action: 'denied', category: 'changes_system', facts: {} }), '✗ jevgate denied · changes_system');
});

test('bashStats per session and all-time, with denied categories and mean latency', () => {
  const entries = parseLog(log);
  const s1 = bashStats(entries, 's1');
  assert.deepEqual(s1, { free: 1, ok: 3, allowed: 2, asked: 1, denied: 1, unreachable: 1, categories: [['exfiltrates', 1]], avgMs: 456, msRecent: [340, 300, 880, 410, 350], blocks: 1, agentDenies: 0 });
  const all = bashStats(entries);
  assert.equal(all.free, 2);
  assert.equal(all.ok, 4);
  assert.equal(all.agentDenies, 1);
  assert.equal(latestSession(entries), 's2');
  const text = formatStats(s1, all, 's1');
  assert.match(text, /^jevgate guard \(bash \+ file tools\)\nsession   free     1 \( 14%\)  ok     3 \(allow 2\)  asked    1  denied    1  unreachable   1  avg 456ms/);
  assert.match(text, /all-time  free     2/);
  assert.match(text, /denied by category \(all-time\): exfiltrates 1/);
});

test('kb formatting', () => {
  assert.equal(kb(300), '300');
  assert.equal(kb(8200), '8.2k');
});

test('groupSummary lists asks and denials, then counts allows', () => {
  assert.deepEqual(groupSummary(['▸ jevgate allow · nothing flagged · 300ms', undefined, '▸ jevgate allow · nothing flagged · 200ms']), ['▸ jevgate allow ×2']);
  assert.deepEqual(groupSummary(['? jevgate asked · deletes local_no_copy · 400ms', '▸ jevgate allow · nothing flagged · 1ms']), ['? jevgate asked · deletes local_no_copy · 400ms', '▸ jevgate allow ×1']);
  assert.deepEqual(groupSummary([undefined]), []);
});
