import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDiff, doneCheck, type DoneHost, type DoneInput } from '../src/done.ts';
import { DEFAULTS } from '../src/config.ts';
import type { Runner } from '../src/bash-context.ts';
import type { FetchLike } from '../src/jev.ts';

/** A repo with one tracked change, one new file and a lock file. */
const repo =
  (over: Record<string, string | undefined> = {}): Runner =>
  (_p, args, _cwd, opts) => {
    const k = args.join(' ');
    if (k in over) return over[k];
    if (k === 'rev-parse --is-inside-work-tree') return 'true\n';
    if (k === 'rev-parse --verify HEAD') return 'abc\n';
    if (k === 'diff HEAD --name-only --no-color') return 'src/slug.ts\npackage-lock.json\n';
    if (k === 'ls-files --others --exclude-standard') return 'tests/slug.test.ts\n';
    if (k === 'diff HEAD --no-color --no-ext-diff -- src/slug.ts') return '+export const slugify = 1;\n';
    // --no-index exits 1 when the files differ: only readable with anyExit
    if (k === 'diff --no-index --no-color -- /dev/null tests/slug.test.ts') return opts?.anyExit ? '+test slugify\n' : undefined;
    return undefined;
  };

test('collectDiff: tracked and new files, generated ones counted but left out', async () => {
  const d = await collectDiff(repo(), '/repo', 60000);
  assert.equal(d?.truncated, false);
  assert.match(d!.diff, /\+export const slugify/);
  assert.match(d!.diff, /\+test slugify/);
  assert.match(d!.diff, /\[1 generated\/lock\/binary file\(s\) omitted\]/);
  assert.equal(await collectDiff(repo({ 'rev-parse --is-inside-work-tree': undefined }), '/x', 60000), undefined);
});

const noul = (n: number) => ({ type: 'noul', noul: n });
const score = (s: number) => ({ type: 'score', score: s, legend: {}, probabilities: {}, confidence: 1 });
const jev = (coverage: number): FetchLike => async () => ({
  status: 200,
  ok: true,
  text: JSON.stringify({ model: 'j', answers: { coverage: score(coverage), claims_backed: noul(0.9), leftovers: noul(0.1), asks_user: noul(0.05) } }),
});
const host = (fetch: FetchLike, run: Runner = repo()): DoneHost => ({ cfg: DEFAULTS, apiKey: 'k', run, fetch, cwd: '/repo', timed: (p) => p });
const edited: DoneInput = {
  session: 's',
  finalMessage: 'Added slugify with a test.',
  rows: [
    { role: 'user', text: 'Add slugify and a test for it.' },
    { role: 'assistant', text: 'Done.', toolUses: [{ tool: 'Write', input: { file_path: 'src/slug.ts' } }] },
  ],
  request: 'Add slugify and a test for it.',
  blocks: 0,
};

test('a turn that did the work passes; one that missed part of it gets the follow-up', async () => {
  assert.equal((await doneCheck(host(jev(3)), edited)).action, 'pass');
  const out = await doneCheck(host(jev(1.9)), edited);
  assert.equal(out.action, 'block');
  if (out.action === 'block') {
    assert.match(out.reason, /^jevgate done-check: the main change is there/);
    assert.equal(out.log.action, 'block');
  }
});

test('nothing to judge: no file change, no diff, no request, or the follow-ups used up', async () => {
  const ranOnly = { ...edited, rows: [{ role: 'user' as const, text: 'run the tests' }, { role: 'assistant' as const, text: 'ok', toolUses: [{ tool: 'Bash', input: { command: 'npm test' } }] }] };
  assert.equal((await doneCheck(host(jev(0)), ranOnly)).log?.action, 'skip-no-change');
  assert.equal((await doneCheck(host(jev(0), repo({ 'rev-parse --is-inside-work-tree': undefined })), edited)).log?.action, 'skip-no-diff');
  assert.equal((await doneCheck(host(jev(0)), { ...edited, request: undefined })).log?.action, 'skip-no-request');
  assert.equal((await doneCheck(host(jev(0)), { ...edited, blocks: DEFAULTS.doneMaxBlocks })).log?.action, 'cap-reached');
});
