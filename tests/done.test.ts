import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doneCheck, snapshotTree, toolEdits, treeDiff, type DoneHost, type DoneInput } from '../src/done.ts';
import { DEFAULTS } from '../src/config.ts';
import type { Runner } from '../src/bash-context.ts';
import type { FetchLike } from '../src/jev.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TREE_DIFF =
  'diff --git a/src/slug.ts b/src/slug.ts\n+export const slugify = 1;\n' +
  'diff --git a/package-lock.json b/package-lock.json\n+{}\n' +
  'diff --git a/tests/slug.test.ts b/tests/slug.test.ts\n+test slugify\n';

/** A repository whose working tree snapshots to B, with a change since A. */
const repo =
  (over: Record<string, string | undefined> = {}): Runner =>
  (p, args) => {
    if (p === 'sh') return 'snapshot' in over ? over.snapshot : `${B}\n`;
    const k = args.join(' ');
    if (k in over) return over[k];
    if (k === `diff --no-color --no-ext-diff ${A} ${B}`) return TREE_DIFF;
    return undefined;
  };

test('snapshotTree: a tree hash from a throwaway index, nothing outside a repository', async () => {
  let seen: string[] = [];
  const run: Runner = (p, args) => ((seen = [p, ...args]), `${B}\n`);
  assert.equal(await snapshotTree(run, '/repo', '/run/idx'), B);
  assert.equal(seen[0], 'sh');
  assert.match(seen[2]!, /GIT_INDEX_FILE="\$1" git add -A/);
  assert.equal(seen.at(-1), '/run/idx');
  assert.equal(await snapshotTree(() => undefined, '/x', '/run/idx'), undefined);
  assert.equal(await snapshotTree(() => 'fatal: not a git repository\n', '/x', '/run/idx'), undefined);
});

test('treeDiff: what changed between snapshots, generated files counted but left out', async () => {
  const d = await treeDiff(repo(), '/repo', A, B, 60000);
  assert.equal(d?.truncated, false);
  assert.match(d!.diff, /\+export const slugify/);
  assert.match(d!.diff, /\+test slugify/);
  assert.doesNotMatch(d!.diff, /package-lock/);
  assert.match(d!.diff, /\[1 generated\/lock\/binary file\(s\) omitted\]/);
  assert.equal(await treeDiff(repo({ [`diff --no-color --no-ext-diff ${A} ${B}`]: '' }), '/repo', A, B, 60000), undefined);
});

test('toolEdits: the file tools\' edits, for sessions outside git', () => {
  const d = toolEdits(
    [
      { name: 'Edit', input: { file_path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2' } },
      { name: 'Write', input: { file_path: 'b.ts', content: 'export {}' } },
      { name: 'Bash', input: { command: "sed -i '' s/a/b/ c.ts" } },
    ],
    60000,
  );
  assert.match(d!.diff, /^\[no git snapshot/);
  assert.match(d!.diff, /Edit a\.ts\n- x = 1\n\+ x = 2/);
  assert.match(d!.diff, /Write b\.ts\n\+ export \{\}/);
  assert.equal(toolEdits([{ name: 'Bash', input: { command: 'echo > x' } }], 60000), undefined);
});

const noul = (n: number) => ({ type: 'noul', noul: n });
const score = (s: number) => ({ type: 'score', score: s, legend: {}, probabilities: {}, confidence: 1 });
/** Jev answering `coverage`, keeping each request body in `sent`. */
const jev = (coverage: number, sent: Record<string, unknown>[] = []): FetchLike => async (_url, init) => {
  sent.push(JSON.parse(init.body));
  return { status: 200, ok: true, text: JSON.stringify({ model: 'j', answers: { coverage: score(coverage), claims_backed: noul(0.9), asks_user: noul(0.05) } }) };
};
const host = (fetch: FetchLike, run: Runner = repo()): DoneHost => ({ cfg: DEFAULTS, apiKey: 'k', run, fetch, cwd: '/repo', indexPath: '/run/idx', timed: (p) => p });
const edited: DoneInput = {
  session: 's',
  finalMessage: 'Added slugify with a test. Tests pass.',
  rows: [
    { role: 'user', text: 'we need a slug for titles' },
    { role: 'assistant', text: 'A slugify helper would do.' },
    { role: 'user', text: 'Add slugify and a test for it.' },
    {
      role: 'assistant',
      text: 'Added slugify with a test. Tests pass.',
      toolUses: [
        { tool: 'Write', input: { file_path: 'src/slug.ts', content: 'export const slugify = 1;' } },
        { tool: 'Bash', input: { command: 'npm test' }, text: 'x'.repeat(900) + '# pass 2' },
      ],
    },
  ],
  request: 'Add slugify and a test for it.',
  blocks: 0,
  base: A,
};

test('a turn that did the work passes; one that missed part of it gets the follow-up', async () => {
  assert.equal((await doneCheck(host(jev(3)), edited)).action, 'pass');
  const out = await doneCheck(host(jev(1.9)), edited);
  assert.equal(out.action, 'block');
  if (out.action === 'block') {
    assert.match(out.reason, /^jevgate done-check: the main change is there/);
    assert.equal(out.log.action, 'block');
    assert.equal(out.log.source, 'git');
    const state = out.log.state as { request_latest: string; commands: unknown[] };
    assert.equal(state.request_latest, 'Add slugify and a test for it.');
    assert.equal(state.commands.length, 1);
  }
});

test('Jev sees the conversation, the diff since the request started and the commands with their output tails', async () => {
  const sent: Record<string, unknown>[] = [];
  await doneCheck(host(jev(3, sent)), edited);
  const state = sent[0]!.state as Record<string, unknown>;
  assert.deepEqual(state.recent, [
    { role: 'user', text: 'we need a slug for titles' },
    { role: 'assistant', text: 'A slugify helper would do.' },
    { role: 'user', text: 'Add slugify and a test for it.' },
  ]);
  assert.match(state.diff as string, /\+export const slugify/);
  const [cmd] = state.commands as { command: string; output_tail: string }[];
  assert.equal(cmd!.command, 'npm test');
  assert.equal(cmd!.output_tail.length, 500);
  assert.ok(cmd!.output_tail.endsWith('# pass 2'));
  assert.equal('request_first' in state, false);
  assert.deepEqual(Object.keys(sent[0]!.questions as object).sort(), ['asks_user', 'claims_backed', 'coverage']);
});

test("a follow-up's turn is judged with the request's edits, its prompt left out of the conversation", async () => {
  const sent: Record<string, unknown>[] = [];
  const followUp = 'jevgate done-check: only a small part of the request is done (coverage 1.0 of 3). Re-check.';
  const input = { ...edited, rows: [...edited.rows, { role: 'user' as const, text: followUp }, { role: 'assistant' as const, text: 'It is complete.' }], finalMessage: 'It is complete.', blocks: 1 };
  const out = await doneCheck(host(jev(3, sent)), input);
  assert.equal(out.log?.action, 'allow');
  const recent = (sent[0]!.state as { recent: { text: string }[] }).recent;
  assert.ok(recent.every((t) => !t.text.startsWith('jevgate done-check:')));
});

test('without a snapshot (outside git, or none taken) the file tools\' edits are judged', async () => {
  const sent: Record<string, unknown>[] = [];
  const out = await doneCheck(host(jev(3, sent), repo({ snapshot: undefined })), edited);
  assert.equal(out.log?.source, 'tools');
  assert.match((sent[0]!.state as { diff: string }).diff, /Write src\/slug\.ts/);
  assert.equal((await doneCheck(host(jev(3)), { ...edited, base: undefined })).log?.source, 'tools');
});

test('nothing to judge: no file change, no diff, no request, or the follow-ups used up', async () => {
  const ranOnly = { ...edited, rows: [{ role: 'user' as const, text: 'run the tests' }, { role: 'assistant' as const, text: 'ok', toolUses: [{ tool: 'Bash', input: { command: 'npm test' } }] }] };
  assert.equal((await doneCheck(host(jev(0)), ranOnly)).log?.action, 'skip-no-change');
  assert.equal((await doneCheck(host(jev(0), repo({ [`diff --no-color --no-ext-diff ${A} ${B}`]: '' })), edited)).log?.action, 'skip-no-diff');
  assert.equal((await doneCheck(host(jev(0)), { ...edited, request: undefined })).log?.action, 'skip-no-request');
  assert.equal((await doneCheck(host(jev(0)), { ...edited, blocks: DEFAULTS.doneMaxBlocks })).log?.action, 'cap-reached');
});
