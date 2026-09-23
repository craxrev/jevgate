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
function harness(answers: (string | undefined)[], percent: { value: number }) {
  const handlers = new Map<string, Handler>();
  const on = (name: string, a: unknown, b?: unknown) => {
    const h = (typeof a === 'function' ? a : b) as Handler;
    if (!handlers.has(name)) handlers.set(name, h);
  };
  const asked: string[] = [];
  const nexts: string[] = [];
  const $ = {
    session: {
      id: async () => 's',
      usage: async () => ({ context: { percent: percent.value } }),
      compact: async () => handlers.get('session.compact')!($, { trigger: 'plugin', messages: [] }, () => { nexts.push('plugin'); return { messages: [] }; }),
      messages: async () => [],
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
    env: { get: async () => undefined },
    fs: { exists: async () => false, read: async () => '', write: async () => {} },
    settings: { read: async () => ({}) },
  };
  register(on as never, { compactUseJev: false } as never);
  const compact = (trigger: string, instructions?: string) => handlers.get('session.compact')!($, { trigger, messages: [], instructions }, () => { nexts.push(trigger); return { messages: [] }; });
  const turn = (agentId?: string) => handlers.get('turn.complete')!($, { agentId }, () => undefined);
  return { compact, turn, asked, nexts };
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
