import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPhrase, flagMeanings } from '../src/explain.ts';
import { BASH_QUESTIONS } from '../src/facts.ts';

test('flagMeanings: the criteria of each flagged value, unsure ones listing the options, not requested on its own', () => {
  const m = flagMeanings(
    { deletes: 'unsure', ships: 'none', changes_system: 'true', rewrites_history: 'false', requested: 'false' },
    ['deletes unsure', 'changes_system', 'not requested'],
    BASH_QUESTIONS,
  );
  assert.equal(m.length, 3);
  assert.match(m[0] ?? '', /^deletes unsure: the checker could not tell whether any of these applies: Something on this machine.* \/ Anything on another machine/);
  assert.match(m[1] ?? '', /^changes_system: Elevated privileges/);
  assert.match(m[2] ?? '', /^not requested: Clearly outside/);
});

test('cleanPhrase: one line, quotes stripped, capped', () => {
  assert.equal(cleanPhrase(' "a\n  b" '), 'a b');
  assert.equal(cleanPhrase(''), undefined);
  assert.equal(cleanPhrase(undefined), undefined);
  const long = cleanPhrase('x'.repeat(500))!;
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
});
