import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANCEL, LATER, SUMMARY, TRIM, choiceOf, snoozeTo } from '../src/compact-ask.ts';
import { register } from '../hooks/compact.ts';

test('choiceOf maps the options; Esc and free text are none', () => {
  assert.equal(choiceOf(TRIM), 'trim');
  assert.equal(choiceOf(SUMMARY), 'summary');
  assert.equal(choiceOf(LATER), 'none');
  assert.equal(choiceOf(CANCEL), 'none');
  assert.equal(choiceOf(undefined), 'none');
  assert.equal(choiceOf('whatever'), 'none');
});

test('snoozeTo is the next 10% step', () => {
  assert.equal(snoozeTo(60), 70);
  assert.equal(snoozeTo(63.4), 70);
  assert.equal(snoozeTo(79.9), 80);
});

type Handler = ($: unknown, e: Record<string, unknown>, next: (e: unknown) => unknown) => Promise<unknown>;

/** The module registered against a fake engine: `answers` are what the dialog returns in turn (undefined = Esc). */
type Extra = {
  useJev?: boolean;
  /** Where the plugin runs from: the cache for a marketplace install, any folder for a directory marketplace or --plugin-dir. */
  root?: string;
  fetch?: (url: string, init: { body: string }) => Promise<unknown>;
  /** A program's result for `$.process.run` (appends are handled apart). */
  run?: (argv: string[]) => { exitCode: number; stdout: string } | undefined;
  rows?: unknown[];
  /** Plugin options on top of the harness's own. */
  options?: Record<string, unknown>;
};

function harness(answers: (string | undefined)[], percent: { value: number }, extra: Extra = {}) {
  const handlers = new Map<string, { tool?: string | RegExp; h: Handler }[]>();
  const on = (name: string, a: unknown, b?: unknown) => {
    const h = (typeof a === 'function' ? a : b) as Handler;
    const tool = typeof a === 'function' ? undefined : (a as { tool?: string | RegExp }).tool;
    handlers.set(name, [...(handlers.get(name) ?? []), { tool, h }]);
  };
  /** The first hook on `name` whose tool matcher takes `tool`. */
  const pick = (name: string, tool?: string): Handler =>
    handlers.get(name)!.find((r) => r.tool === undefined || (tool !== undefined && (typeof r.tool === 'string' ? r.tool === tool : r.tool.test(tool))))!.h;
  const submitted: string[] = [];
  const asked: string[] = [];
  const nexts: string[] = [];
  const files = new Map<string, string>();
  const timers: (() => unknown)[] = [];
  let reads = 0;
  const $ = {
    session: {
      id: async () => 's',
      usage: async () => ({ context: { percent: percent.value } }),
      compact: async () => pick('session.compact')($, { trigger: 'plugin', messages: [] }, () => { nexts.push('plugin'); return { messages: [] }; }),
      messages: async () => extra.rows ?? [],
      cwd: async () => '/repo',
      root: async () => '/repo',
    },
    ui: {
      ask: async (q: string) => {
        asked.push(q);
        const a = answers.shift();
        if (a === undefined) throw new Error('dismissed');
        return a;
      },
      toast: () => {}, log: () => {}, invalidate: () => {}, open: async () => {},
    },
    env: { get: async (k: string) => (k === 'HOME' ? '/h' : undefined) },
    fs: {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => (reads++, files.get(p) ?? ''),
      // yields first, so two unchained rewrites would both read the same old text
      write: async (p: string, t: string) => { await new Promise((r) => setTimeout(r, 5)); files.set(p, t); },
    },
    settings: { read: async () => ({ env: { TYPESAFE_API_KEY: 'k' } }) },
    http: { fetch: extra.fetch ?? (async () => ({ status: 500, ok: false, text: '', headers: {} })) },
    plugin: { root: extra.root ?? '/h/.claude/plugins/cache/jevgate/jevgate/0.5.0', name: 'jevgate' },
    process: {
      // appends (`sh -c 'cat >> "$1"' jevgate <path>`) land in `files`; anything else succeeds empty
      run: async (argv: string[], init?: { stdin?: string }) => {
        if (argv[0] === 'sh' && String(argv[2]).includes('cat >>')) {
          await new Promise((r) => setTimeout(r, 5));
          files.set(argv[4]!, (files.get(argv[4]!) ?? '') + (init?.stdin ?? ''));
        }
        return { stderr: '', ...(extra.run?.(argv) ?? { exitCode: 0, stdout: '' }) };
      },
    },
    clock: {
      after: (_ms: number, fn: () => unknown) => (timers.push(fn), { cancel: () => {} }),
      every: () => ({ cancel: () => {} }),
      // Jev's deadline never fires here
      sleep: () => new Promise(() => {}),
    },
    prompt: { submit: async (p: { text: string }) => void submitted.push(p.text) },
  };
  register(on as never, { compactUseJev: extra.useJev ?? false, ...extra.options } as never);
  const compact = (trigger: string, instructions?: string) => pick('session.compact')($, { trigger, messages: [], instructions }, () => { nexts.push(trigger); return { messages: [] }; });
  const turn = (agentId?: string, answer = '') => pick('turn.complete')($, { agentId, reason: 'answer', answer }, () => undefined);
  const start = (text: string) => pick('turn.start')($, { text, turnId: 't' }, () => undefined);
  const end = (reason: string) => pick('session.end')($, { reason }, () => undefined);
  const handler = (name: string, tool?: string) => pick(name, tool);
  const runTimers = async () => { while (timers.length) await timers.shift()!(); };
  return { $, compact, turn, start, end, handler, asked, nexts, files, timers, runTimers, submitted, reads: () => reads };
}

test('/compact asks; Cancel and Esc keep the conversation, the summary hands to Claude Code', async () => {
  const p = { value: 30 };
  const h = harness([CANCEL, undefined, SUMMARY], p);
  assert.match(String((await h.compact('manual') as { skip: string }).skip), /cancelled/);
  assert.match(String((await h.compact('manual') as { skip: string }).skip), /cancelled/);
  await h.compact('manual');
  assert.deepEqual(h.nexts, ['manual']);
  assert.equal(h.asked.length, 3);
});

test("at Claude Code's own limit, Claude Code compacts without asking", async () => {
  const h = harness([], { value: 95 });
  await h.compact('auto');
  await h.compact('precompute');
  assert.deepEqual(h.nexts, ['auto', 'precompute']);
  assert.equal(h.asked.length, 0);
});

test('the reminder asks at compactAtPercent, snoozes to the next 10% step, and resets once context drops', async () => {
  const p = { value: 55 };
  const h = harness([LATER, undefined, SUMMARY], p);
  await h.turn();
  assert.equal(h.asked.length, 0, 'below 60% nothing is asked');
  p.value = 62; await h.turn();
  assert.equal(h.asked.length, 1);
  assert.match(h.asked[0]!, /62% full/);
  p.value = 66; await h.turn();
  assert.equal(h.asked.length, 1, 'snoozed until 70%');
  p.value = 71; await h.turn();
  assert.equal(h.asked.length, 2, 'asked again at 70%; Esc snoozes to 80%');
  p.value = 40; await h.turn();
  p.value = 61; await h.turn();
  assert.equal(h.asked.length, 3, 'context dropped under 60%: the snooze reset');
  assert.deepEqual(h.nexts, ['plugin'], 'the summary answer reached Claude Code as the plugin compaction');
});

test("a subagent's turn never asks", async () => {
  const h = harness([], { value: 80 });
  await h.turn('agent-1');
  assert.equal(h.asked.length, 0);
});

test('/compact with instructions runs the summary without asking', async () => {
  const h = harness([], { value: 30 });
  await h.compact('manual', 'keep the latency discussion');
  assert.deepEqual(h.nexts, ['manual']);
  assert.equal(h.asked.length, 0);
  const blank = harness([CANCEL], { value: 30 });
  await blank.compact('manual', '  ');
  assert.equal(blank.asked.length, 1, 'blank instructions still ask');
});

test('/clear drops the snooze: the new conversation is asked at compactAtPercent again', async () => {
  const p = { value: 62 };
  const h = harness([LATER, LATER], p);
  await h.turn();
  await h.turn();
  assert.equal(h.asked.length, 1);
  await h.end('clear');
  await h.turn();
  assert.equal(h.asked.length, 2);
});

test('the module appends to stats.jsonl in the order it logged, even when two land at once', async () => {
  const h = harness([CANCEL, CANCEL], { value: 30 });
  await Promise.all([h.compact('manual'), h.compact('manual')]);
  const path = '/h/.claude/jevgate/stats.jsonl';
  const lines = h.files.get(path)!.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.feature, l.action, l.session]), [['compact', 'cancelled', 's'], ['compact', 'cancelled', 's']]);
  assert.equal(h.files.has('/h/.claude/jevgate/ui.jsonl'), false);
});

test('an interrupted trim stops waiting on Jev, whose fetch has no signal', async () => {
  const h = harness([TRIM], { value: 30 }, { useJev: true, fetch: () => new Promise(() => {}) });
  const msgs = Array.from({ length: 10 }, (_, i) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `c${i}` }, text: '' }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'x'.repeat(5000), isError: false }] },
  ]).flat();
  const ctl = new AbortController();
  const next = Object.assign(() => ({ messages: [] }), { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  const t = Date.now();
  const r = (await h.handler('session.compact')(h.$, { trigger: 'manual', messages: msgs }, next as never)) as { messages?: unknown[] };
  assert.ok(Date.now() - t < 1000, 'still waiting on the fetch');
  assert.equal(r.messages?.length, msgs.length);
});

test("a guarded tool's result comes back before the logs are read", async () => {
  const h = harness([], { value: 30 });
  const result = { result: 'ok' };
  const before = h.reads();
  const r = await h.handler('tool.call', 'Bash')(h.$, { tool: 'Bash', tool_use_id: 'x' }, () => result);
  assert.equal(r, result);
  assert.equal(h.reads(), before);
  assert.equal(h.timers.length, 1);
  await h.timers[0]!();
});

/** Jev as the module meets it: answers by which questions a request asks. */
const choiceA = (p: Record<string, number>) => ({ type: 'choice', choice: Object.keys(p)[0], probabilities: p, confidence: 0.5 });
const noulA = (n: number) => ({ type: 'noul', noul: n });
function jevFake(over: { coverage?: number; inContext?: number } = {}) {
  return async (_url: string, init: { body: string }) => {
    const q = Object.keys(JSON.parse(init.body).questions);
    const answers = q.includes('coverage')
      ? { coverage: { type: 'score', score: over.coverage ?? 3, legend: {}, probabilities: {}, confidence: 1 }, claims_backed: noulA(0.9), leftovers: noulA(0.1), asks_user: noulA(0.05) }
      : q.includes('in_context')
      ? { in_context: noulA(over.inContext ?? 0.1) }
      : { deletes: choiceA({ none: 0.97, local_no_copy: 0.02, remote: 0.01 }), ships: choiceA({ none: 0.98, live_reversible: 0.01, public_permanent: 0.01 }), changes_system: noulA(0.03), rewrites_history: noulA(0.02), uploads_data: noulA(0.04), exposes_secret: noulA(0.02), requested: noulA(0.95) };
    return { status: 200, ok: true, text: JSON.stringify({ model: 'j', answers }), headers: {} };
  };
}
const DATA = '/h/.claude/jevgate';
const RUN = '/h/.claude/jevgate/run';

test('a guarded call: the verdict and its match are written before the call goes on, then logged', async () => {
  const h = harness([], { value: 30 }, { fetch: jevFake() });
  let seen: string | undefined;
  const r = await h.handler('tool.call', 'Bash')(h.$, { tool: 'Bash', tool_use_id: 'toolu_9', command: 'rm -rf build' }, () => {
    seen = h.files.get(`${RUN}/verdicts/toolu_9`);
    return { result: 'ok' };
  });
  assert.deepEqual(r, { result: 'ok' });
  assert.equal(seen, '*\tallow\t"jevgate: nothing flagged"\n');
  assert.equal(h.files.get(`${RUN}/verdicts/toolu_9.match`), '"command":"rm -rf build"');
  await h.runTimers();
  const logged = h.files.get(`${DATA}/stats.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((l) => [l.feature, l.action, l.tool_use_id]), [['bash', 'allow', 'toolu_9']]);
  assert.equal(logged[0].command, undefined);
});

test('a subagent whose answer is already in the conversation is refused before it starts', async () => {
  const rows = [{ role: 'user', text: 'what does slugify do?' }, { role: 'assistant', text: 'It lowercases and dashes the title.' }];
  const h = harness([], { value: 30 }, { fetch: jevFake({ inContext: 0.99 }), rows });
  let ran = false;
  const r = (await h.handler('tool.call', 'Agent')(h.$, { tool: 'Agent', tool_use_id: 'a1', prompt: 'find what slugify does' }, () => ((ran = true), {}))) as { deny?: string };
  assert.equal(ran, false);
  assert.match(r.deny!, /already be in the recent conversation/);
  const passed = harness([], { value: 30 }, { fetch: jevFake({ inContext: 0.1 }), rows });
  await passed.handler('tool.call', 'Agent')(passed.$, { tool: 'Agent', tool_use_id: 'a2', prompt: 'read the repo' }, () => ((ran = true), {}));
  assert.equal(ran, true);
});

test('done-check: a turn that missed part of the request gets follow-ups, at most doneMaxBlocks, then lets it stop', async () => {
  const rows = [
    { role: 'user', text: 'Add slugify and a test for it.' },
    { role: 'assistant', text: 'Done.', toolUses: [{ tool: 'Write', input: { file_path: 'src/slug.ts' } }] },
  ];
  // a repository with one changed file
  const run = (argv: string[]) => {
    if (argv[0] !== 'git') return undefined;
    const k = argv.slice(1).join(' ');
    if (k === 'diff HEAD --name-only --no-color') return { exitCode: 0, stdout: 'src/slug.ts\n' };
    if (k.startsWith('diff HEAD --no-color')) return { exitCode: 0, stdout: '+export const slugify = 1;\n' };
    return { exitCode: 0, stdout: 'x\n' };
  };
  const h = harness([], { value: 30 }, { fetch: jevFake({ coverage: 1.9 }), rows, run, options: { doneEnabled: true } });
  await h.start('Add slugify and a test for it.');
  await h.turn(undefined, 'Added slugify.');
  await h.runTimers();
  assert.equal(h.submitted.length, 1);
  assert.match(h.submitted[0]!, /^jevgate done-check: the main change is there/);
  // the follow-up's own turn continues the request, it does not start a new one
  await h.start(h.submitted[0]!);
  await h.turn(undefined, 'Added slugify.');
  await h.runTimers();
  assert.equal(h.submitted.length, 2);
  await h.start(h.submitted[1]!);
  await h.turn(undefined, 'Added slugify.');
  await h.runTimers();
  assert.equal(h.submitted.length, 2, 'past doneMaxBlocks the turn may end');
  const actions = h.files.get(`${DATA}/stats.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l).action);
  assert.deepEqual(actions, ['block', 'block', 'cap-reached']);
});

test('the done-check is off unless switched on', async () => {
  const h = harness([], { value: 30 }, { fetch: jevFake({ coverage: 0 }), rows: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y', toolUses: [{ tool: 'Write', input: { file_path: 'a' } }] }] });
  await h.start('x');
  await h.turn(undefined, 'done');
  await h.runTimers();
  assert.equal(h.submitted.length, 0);
  assert.equal(h.files.has(`${DATA}/stats.jsonl`), false);
});

test("a turn's end logs the free calls slips.sh found judged by the classifier", async () => {
  const run = (argv: string[]) => (String(argv[1]).endsWith('/hooks/slips.sh') && argv[2] === `${RUN}/pending/s` ? { exitCode: 0, stdout: 'toolu_Z\tBash\ntoolu_W\tWrite\n' } : undefined);
  const h = harness([], { value: 30 }, { run });
  await h.turn();
  await h.runTimers();
  const logged = h.files.get(`${DATA}/stats.jsonl`)!.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((l) => [l.feature, l.action, l.tool_use_id]), [['bash', 'slipped', 'toolu_Z'], ['file', 'slipped', 'toolu_W']]);
});

test('the verdict lands where answer.sh reads it, however the plugin is loaded', async () => {
  for (const root of ['/h/.claude/plugins/cache/jevgate/jevgate/0.5.0', '/h/dev/jevgate']) {
    const h = harness([], { value: 30 }, { fetch: jevFake(), root });
    await h.handler('tool.call', 'Bash')(h.$, { tool: 'Bash', tool_use_id: 'toolu_R', command: 'rm -rf build' }, () => ({}));
    assert.equal(h.files.get(`${RUN}/verdicts/toolu_R`), '*\tallow\t"jevgate: nothing flagged"\n', root);
  }
});
