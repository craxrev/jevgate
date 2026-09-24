import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagLabel, parseLog, tally, statusText, footerLabel, bashRowText, groupSummary, askAnswer, kb, bashStats, latestSession, formatStats } from '../src/ui-model.ts';

const log = [
  { ts: 't', feature: 'bash', action: 'free', session: 's1', tool_use_id: 'a', command: 'git status' },
  { ts: 't', feature: 'bash', action: 'allow', session: 's1', tool_use_id: 'b', facts: { deletes: 'none' }, scores: {}, ms: 300 },
  { ts: 't', feature: 'bash', action: 'denied', session: 's1', tool_use_id: 'c', category: 'deletes remote, not requested', reason: 'jevgate: denied · deletes remote, not requested', facts: { deletes: 'remote' }, scores: {}, ms: 880 },
  { ts: 't', feature: 'bash', action: 'unreachable', session: 's1', tool_use_id: 'd', error: 'Jev HTTP 401', ms: 830 },
  { ts: 't', feature: 'bash', action: 'asked', session: 's1', tool_use_id: 'h', category: 'deletes local_no_copy', facts: { deletes: 'local_no_copy' }, scores: {}, ms: 410 },
  { ts: 't', feature: 'bash', action: 'ask-approved', session: 's1', tool_use_id: 'h' },
  { ts: 't', feature: 'bash', action: 'asked', session: 's1', tool_use_id: 'k', category: 'blocked', ms: 90 },
  { ts: 't', feature: 'file', action: 'denied', session: 's1', tool_use_id: 'f', category: 'exposes_secret', reason: 'jevgate: denied · exposes_secret (path holds credentials)' },
  { ts: 't', feature: 'bash', action: 'allow', session: 's0', tool_use_id: 'e', facts: {}, scores: {}, ms: 200 },
  { ts: 't', feature: 'done', action: 'block', session: 's1' },
  { ts: 't', feature: 'compact', action: 'verbatim', session: 's1' },
  { ts: 't', feature: 'compact', action: 'summary', session: 's1' },
  { ts: 't', feature: 'agent', action: 'deny', session: 's2' },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

test('parseLog skips junk lines', () => {
  assert.equal(parseLog('garbage\n' + log + '\n{bad').length, 13);
});

test('tally counts per session; free apart, unreachable counts as denied', () => {
  assert.deepEqual(tally(parseLog(log), 's1'), { free: 1, allowed: 1, asked: 2, denied: 3, blocks: 1, agentDenies: 0, compactions: 1 });
  assert.deepEqual(tally(parseLog(log), 's0'), { free: 0, allowed: 1, asked: 0, denied: 0, blocks: 0, agentDenies: 0, compactions: 0 });
  assert.equal(tally(parseLog(log), 's2').agentDenies, 1);
});

test('statusText is compact and empty when nothing happened', () => {
  assert.equal(statusText({ free: 9, allowed: 0, asked: 0, denied: 0, blocks: 0, agentDenies: 0, compactions: 0 }), undefined);
  assert.equal(statusText({ free: 9, allowed: 3, asked: 2, denied: 1, blocks: 0, agentDenies: 2, compactions: 2 }), 'jev ✓3 allowed · ?2 asked · ⊘1 denied · ⇢2 subagent · ⇊2 compact');
});

test('footerLabel is the short form; free commands do not show', () => {
  assert.equal(footerLabel({ free: 4, allowed: 0, asked: 0, denied: 0, blocks: 0, agentDenies: 0, compactions: 0 }), undefined);
  assert.equal(footerLabel({ free: 9, allowed: 5, asked: 1, denied: 2, blocks: 1, agentDenies: 1, compactions: 1 }), 'jev ✓5 ?1 ⊘2 ✗1 ⇢1 ⇊1');
});

test('bashRowText: one dim line per judged call, nothing for free ones', () => {
  const [free, allow, denied, unreachable, asked, , blocked, secret] = parseLog(log);
  assert.equal(bashRowText(free!), undefined);
  assert.equal(bashRowText(allow!), '▸ jevgate allow · nothing flagged · 300ms');
  assert.equal(bashRowText(denied!), '✗ jevgate denied · deletes remote, not requested');
  assert.match(bashRowText(unreachable!)!, /unreachable.*830ms/);
  assert.equal(bashRowText(asked!), '? jevgate asked · deletes local_no_copy · 410ms');
  assert.equal(bashRowText(blocked!), '? jevgate asked · Jev could not judge (gateway block) · 90ms');
  assert.equal(bashRowText({ ts: 't', feature: 'bash', action: 'unreachable', category: 'blocked', ms: 120 }), '✗ jevgate unreachable · gateway blocked the request · 120ms');
  assert.equal(bashRowText(secret!), '✗ jevgate denied · exposes_secret');
});

test('bashStats per session and all-time: flags per fact, your answers, mean latency', () => {
  const entries = parseLog(log);
  const s1 = bashStats(entries, 's1');
  assert.deepEqual(s1, {
    free: 1, allowed: 1, asked: 2, approved: 1, rejected: 0, blocked: 1, askedBy: [['deletes local_no_copy', 1]], denied: 2, unreachable: 1,
    categories: [['deletes remote', 1], ['not requested', 1], ['file:exposes_secret', 1]], avgMs: 420, msRecent: [300, 880, 410, 90], timingRecent: [undefined, undefined, undefined, undefined], blocks: 1, agentDenies: 0,
  });
  const all = bashStats(entries);
  assert.equal(all.allowed, 2);
  assert.equal(all.agentDenies, 1);
  assert.equal(latestSession(entries), 's2');
  const text = formatStats(s1, all, 's1');
  assert.match(text, /^jevgate guard \(bash \+ file tools\)\nsession   free     1 \( 14%\)  allow     1  asked    2 \(✓1 ✗0\)  denied    2  unreachable   1  avg 420ms/);
  assert.match(text, /all-time  free     1/);
  assert.match(text, /denied by flag \(all-time\): deletes remote 1, not requested 1, exposes_secret \[F\] 1/);
  assert.match(text, /asked by flag \(all-time\): deletes local_no_copy 1/);
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

test('askAnswer reads your answer off how an asked call settled', () => {
  assert.equal(askAnswer({ result: { stdout: '' }, isError: false }), 'ask-approved');
  assert.equal(askAnswer({ result: 'Error: Exit code 1', text: 'Exit code 1', isError: true }), 'ask-approved', 'ran, then failed');
  assert.equal(askAnswer({ text: "The user doesn't want to proceed with this tool use. The tool use was rejected", isError: true }), 'ask-rejected');
  assert.equal(askAnswer({ result: 'User rejected tool use', isError: true }), 'ask-rejected');
  assert.equal(askAnswer({ result: 'Error: jevgate: asking · deletes local_no_copy', text: 'jevgate: asking · deletes local_no_copy', isError: true }), undefined, 'refused with no one to ask');
});

test('bashStats keeps call timings next to latencies, and the newest Jev call of any hook', () => {
  const entries = parseLog([
    { ts: '1', feature: 'bash', action: 'allow', session: 's', ms: 600, prepMs: 150, connectMs: 90, serverMs: 70 },
    { ts: '2', feature: 'bash', action: 'allow', session: 's', ms: 500 },
    { ts: '3', feature: 'bash', action: 'unreachable', session: 's', ms: 8132, prepMs: 150, connectMs: 90, tries: 2 },
    { ts: '4', feature: 'done', action: 'pass', session: 's', ms: 900, prepMs: 1, connectMs: 80, serverMs: 300 },
    { ts: '5', feature: 'bash', action: 'free', session: 's' },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const s = bashStats(entries, 's');
  assert.deepEqual(s.msRecent, [600, 500]);
  assert.deepEqual(s.timingRecent, [{ ms: 600, prep: 150, connect: 90, server: 70, answered: true, tries: 1 }, undefined]);
  assert.deepEqual(s.lastCall, { ms: 900, prep: 1, connect: 80, server: 300, answered: true, tries: 1 });
  assert.deepEqual(bashStats(entries.slice(0, 3), 's').lastCall, { ms: 8132, prep: 150, connect: 90, server: undefined, answered: false, tries: 2 });
});

test('flagLabel marks file-tool flags with [F], kept when the name is cut', () => {
  assert.equal(flagLabel('file:exposes_secret'), 'exposes_secret [F]');
  assert.equal(flagLabel('exposes_secret'), 'exposes_secret');
  assert.equal(flagLabel('file:deletes local_no_copy', 20), 'deletes local_no [F]');
  assert.equal(flagLabel('deletes local_no_copy', 10), 'deletes lo');
});
