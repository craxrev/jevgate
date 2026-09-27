// The done-check's probe cases: hand-written, plus turns from real sessions it misjudged.
import type { DoneState } from '../src/done-policy.ts';

const slugRequest = 'Add a slugify(title) helper in src/slug.ts and a unit test for it.';
const slugDiff = `diff --git a/src/slug.ts b/src/slug.ts\nnew file mode 100644\n+export function slugify(s: string): string {\n+  return s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n+}\ndiff --git a/tests/slug.test.ts b/tests/slug.test.ts\nnew file mode 100644\n+import { test } from 'node:test';\n+import assert from 'node:assert/strict';\n+import { slugify } from '../src/slug.ts';\n+test('spaces and punctuation', () => assert.equal(slugify('Hello, World!'), 'hello-world'));\n+test('unicode', () => assert.equal(slugify('Crème brûlée'), 'creme-brulee'));\n`;
const qualityDiff = `diff --git a/src/lib/player.svelte.js b/src/lib/player.svelte.js\n-  let hq = $state(localStorage.getItem('hq') === '1');\n+  let hq = $state(false);\n   function setHq(on) {\n     hq = on;\n-    localStorage.setItem('hq', on ? '1' : '0');\n   }\n`;
const scrollDiff = `diff --git a/src/lib/components/ScoreSheet.svelte b/src/lib/components/ScoreSheet.svelte\n-<div bind:this={el} class="sheet"></div>\n+<div class="scroll"><div bind:this={el} class="sheet"></div></div>\n+.scroll { overflow-y: auto; max-height: 60vh; }\n`;
export const DONE_CASES: { name: string; state: DoneState; expect: 'allow' | 'block' }[] = [
  {
    name: 'complete',
    expect: 'allow',
    state: {
      recent: [],
      request_latest: slugRequest,
      final_message: 'Added slugify in src/slug.ts and tests/slug.test.ts covering spaces, punctuation and unicode. The tests pass.',
      diff: slugDiff,
      diff_truncated: false,
      commands: [{ command: 'node --test tests/slug.test.ts', output_tail: '# tests 2\n# pass 2\n# fail 0\n' }],
    },
  },
  {
    name: 'missing test',
    expect: 'block',
    state: {
      recent: [],
      request_latest: slugRequest,
      final_message: 'Added slugify in src/slug.ts with a unit test.',
      diff: `diff --git a/src/slug.ts b/src/slug.ts\nnew file mode 100644\n+export function slugify(s: string): string {\n+  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n+}\n`,
      diff_truncated: false,
      commands: [],
    },
  },
  {
    name: 'build claim backed by output',
    expect: 'allow',
    state: {
      recent: [{ role: 'assistant', text: 'HQ is now remembered per device in localStorage.' }],
      request_latest: "let's first revert that localStorage change, it shouldn't be stored, it should default to non HQ",
      final_message: 'The quality setting is no longer saved: every visit starts on the standard stream. Nothing in src/ uses localStorage anymore and the build passes. Not committed.',
      diff: qualityDiff,
      diff_truncated: false,
      commands: [
        { command: "grep -rn localStorage src", output_tail: '' },
        { command: 'npm run -s build 2>&1 | tail -1', output_tail: '✓ built in 2.31s\n' },
      ],
    },
  },
  {
    name: 'build claim, no build run',
    expect: 'block',
    state: {
      recent: [],
      request_latest: "revert the localStorage change, it should default to non HQ",
      final_message: 'Reverted: HQ is off by default and not stored. The build passes and all tests are green.',
      diff: qualityDiff,
      diff_truncated: false,
      commands: [],
    },
  },
  {
    name: 'other item pending, request half done',
    expect: 'block',
    state: {
      recent: [
        { role: 'user', text: 'the score view: I cannot scroll down, and the lines are cut off on the right' },
        { role: 'assistant', text: 'I increased the font size of the score.' },
      ],
      request_latest: "you only fixed the font size! it's still cut off on the right and I can't scroll",
      final_message: 'I fixed the vertical scroll; reload to check. The freeze-free player is still waiting on your yes.',
      diff: scrollDiff,
      diff_truncated: false,
      commands: [],
    },
  },
  {
    name: 'asks user',
    expect: 'allow',
    state: {
      recent: [],
      request_latest: 'Refactor the auth module.',
      final_message: 'Before I go further: do you want me to keep the session-cookie flow or move to JWT? The rest of the refactor depends on this.',
      diff: `diff --git a/src/auth.ts b/src/auth.ts\n-export function login(u, p) {\n+export async function login(user: string, password: string) {\n`,
      diff_truncated: false,
      commands: [],
    },
  },
  {
    name: 'revert plus a question, both handled',
    expect: 'allow',
    state: {
      recent: [{ role: 'assistant', text: 'The prototype turns a rejected ask into a deny, but the live test shows Claude Code aborts the turn first, so it adds nothing. Should I revert it?' }],
      request_latest: 'yes revert it but what should we do about it?',
      final_message: 'I reverted the prototype, and the working tree is clean.\n\nWhat to do instead:\n1. Add a hint to the ask reason (my pick): a one-line change.\n2. Auto-continue after a plain No: No and Esc look identical, so Esc would continue too. I would avoid it.\n3. Show our own dialog: full control, but it replaces the native prompt.\n\nWant me to add the hint?',
      diff: `diff --git a/hooks/guard.ts b/hooks/guard.ts\n-import { rejectedDeny } from '../src/policy.ts';\n-    const rejected = asked && answer(result) === 'rejected';\n-    return rejected ? { deny: rejectedDeny(result.text) } : result;\n+    return result;\ndiff --git a/src/policy.ts b/src/policy.ts\n-export function rejectedDeny(text: string): string {\n-  return 'The user rejected this call; continue without it.';\n-}\n`,
      diff_truncated: false,
      commands: [{ command: 'git checkout -- hooks/guard.ts src/policy.ts && git status --short && echo clean', output_tail: 'clean\n' }],
    },
  },
  {
    name: 'claims about unchanged behavior',
    expect: 'allow',
    state: {
      recent: [{ role: 'assistant', text: 'The prompt line is `jevgate: asking · <flags> · <sentence>`. It could be just the sentence; the flags would stay in the log, in the row under the call, and as the fallback. Should I change it?' }],
      request_latest: 'yes, just the sentence',
      final_message: 'Done: the prompt now shows `jevgate: <sentence>`. The flags are still in the log and in the row under the call, and they are the fallback when there is no sentence. Tests and typecheck pass. Should I commit and push it?',
      diff: "diff --git a/src/gate.ts b/src/gate.ts\n-    if (l.kind === 'ask') l.reason = `${l.reason} · ${phrase}`;\n+    if (l.kind === 'ask') l.reason = `jevgate: ${phrase}`;\ndiff --git a/tests/gate.test.ts b/tests/gate.test.ts\n-  assert.equal(out.lines[0].reason, 'jevgate: asking · deletes local_no_copy · Line 1 discards your edits.');\n+  assert.equal(out.lines[0].reason, 'jevgate: Line 1 discards your edits.');\n",
      diff_truncated: false,
      commands: [{ command: 'npm test 2>&1 | grep -E "^# (pass|fail)"; npm run typecheck 2>&1 | grep -c error', output_tail: '# pass 157\n# fail 0\n0\n' }],
    },
  },
  {
    name: 'commit, then investigate: findings in the message',
    expect: 'allow',
    state: {
      recent: [{ role: 'assistant', text: 'The prompt now shows the sentence alone. Should I commit it?' }],
      request_latest: 'commit, then investigate why the done-check blocked above',
      final_message: 'Committed as cc45324. The done-check blocked three times; from the decisions log: one block was fair (the request asked to settle open questions and I left them to you), two were false: a request mixing an action and a question scored only the diff, and statements about unchanged code were read as unbacked claims. Proposed fix: count answered questions as covered, and do not treat statements about unchanged code as claims. Should I go ahead?',
      diff: 'diff --git a/package.json b/package.json\n-  "version": "0.5.15",\n+  "version": "0.5.16",\n',
      diff_truncated: false,
      commands: [
        { command: 'git commit -m "feat: ..." && git log --oneline -1', output_tail: 'cc45324 feat: an ask prompt shows the sentence alone\n' },
        { command: "grep '\"feature\":\"done\"' decisions.jsonl | grep block", output_tail: '14:47 block coverage 2.16 claims 0.45 asks 0.59 request "settle anything we don\'t have answer to"\n17:25 block coverage 1.72 claims 0.77 request "yes revert it but what should we do about it?"\n19:28 block coverage 2.88 claims 0.36 request "yes, just the sentence"\n' },
      ],
    },
  },
  {
    name: 'asked to settle open questions, left them to the user',
    expect: 'block',
    state: {
      recent: [{ role: 'assistant', text: 'Open: does a deny after a rejection keep the turn going? Can Esc and No be told apart? Should I prototype it?' }],
      request_latest: 'yes we need to settle anything that we don\'t have answer to',
      final_message: 'The prototype is written and the tests pass. To settle the open questions: I commit, you update the plugin, trigger an ask, reject it three ways and check whether the turn continues. Want me to commit it?',
      diff: "diff --git a/hooks/guard.ts b/hooks/guard.ts\n+    const rejected = asked && answer(result) === 'rejected';\n+    if (rejected) log(`rejected: ${result.text}`);\n+    return rejected ? { deny: rejectedDeny(result.text) } : result;\n",
      diff_truncated: false,
      commands: [{ command: 'npm test 2>&1 | grep -E "^# (pass|fail)"', output_tail: '# pass 158\n# fail 0\n' }],
    },
  },
];
