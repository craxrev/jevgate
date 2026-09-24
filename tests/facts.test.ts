import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASH_FACTS,
  FILE_FACTS,
  BASH_QUESTIONS,
  FILE_QUESTIONS,
  DEFAULT_RULES,
  DEFAULT_THRESHOLDS,
  resolveFacts,
  decideFacts,
  mergeRules,
  rawScores,
  type Facts,
} from '../src/facts.ts';
import { fromRaw, fromEnv, thresholds, knownHosts, DEFAULTS } from '../src/config.ts';
import type { JevResponse } from '../src/jev.ts';

const choice = (p: Record<string, number>) => ({ type: 'choice' as const, choice: Object.keys(p)[0]!, probabilities: p, confidence: 0.5 });
const noul = (n: number) => ({ type: 'noul' as const, noul: n });
const quiet = (): JevResponse['answers'] => ({
  deletes: choice({ none: 0.97, local_no_copy: 0.02, remote: 0.01 }),
  ships: choice({ none: 0.98, live_reversible: 0.01, public_permanent: 0.01 }),
  changes_system: noul(0.03),
  rewrites_history: noul(0.02),
  uploads_data: noul(0.04),
  exposes_secret: noul(0.02),
  requested: noul(0.95),
});
const res = (over: JevResponse['answers'] = {}): JevResponse => ({ model: 'j', answers: { ...quiet(), ...over } });
const decide = (over: JevResponse['answers'] = {}) => decideFacts(resolveFacts(res(over), BASH_FACTS));

test('each guard asks its facts; every question names its state fields', () => {
  assert.deepEqual(Object.keys(BASH_QUESTIONS), [...BASH_FACTS]);
  assert.deepEqual(Object.keys(FILE_QUESTIONS), ['deletes', 'changes_system', 'requested']);
  assert.deepEqual(Object.keys(BASH_QUESTIONS.deletes!.criteria as object), ['none', 'local_no_copy', 'remote']);
  assert.deepEqual(Object.keys(BASH_QUESTIONS.ships!.criteria as object), ['none', 'live_reversible', 'public_permanent']);
  for (const q of Object.values(BASH_QUESTIONS)) assert.match(q.instructions, /`command`.*`git_status`.*`known_hosts`/);
  for (const q of Object.values(FILE_QUESTIONS)) assert.match(q.instructions, /`path`.*`exists`/);
  assert.equal(BASH_QUESTIONS.deletes!.instructions.split(' What the command')[1], FILE_QUESTIONS.deletes!.instructions.split(' What the command')[1]);
});

test('resolveFacts: a choice needs positive evidence of none, sums count toward the stricter option', () => {
  const f = resolveFacts(res(), BASH_FACTS);
  assert.deepEqual(f, { deletes: 'none', ships: 'none', changes_system: 'false', rewrites_history: 'false', uploads_data: 'false', exposes_secret: 'false', requested: 'true' });
  const g = resolveFacts(res({
    deletes: choice({ none: 0.34, local_no_copy: 0.33, remote: 0.33 }), // no pick wins, but local+remote is 0.66
    ships: choice({ none: 0.55, live_reversible: 0.25, public_permanent: 0.2 }), // none under 0.6, harm under 0.5
    changes_system: noul(0.45),
    requested: noul(0.55),
  }), BASH_FACTS);
  assert.equal(g.deletes, 'local_no_copy');
  assert.equal(g.ships, 'unsure');
  assert.equal(g.changes_system, 'unsure');
  assert.equal(g.requested, 'unsure');
  assert.equal(resolveFacts(res({ requested: noul(0.5) }), BASH_FACTS).requested, 'unsure');
  assert.equal(resolveFacts(res({ requested: noul(0.25) }), BASH_FACTS).requested, 'false');
  assert.throws(() => resolveFacts({ model: 'j', answers: {} }, BASH_FACTS), /deletes/);
});

test('decideFacts: nothing flagged allows, a flag asks, the worst tier wins', () => {
  assert.equal(decide().action, 'allow');
  const a = decide({ deletes: choice({ local_no_copy: 0.8, none: 0.2 }) });
  assert.equal(a.action, 'ask');
  assert.equal(a.reason, 'jevgate: asking · deletes local_no_copy');
  const d = decide({ deletes: choice({ local_no_copy: 0.8, none: 0.2 }), ships: choice({ public_permanent: 0.9, none: 0.1 }) });
  assert.equal(d.action, 'deny');
  assert.equal(d.reason, 'jevgate: denied · deletes local_no_copy, ships public_permanent');
  assert.equal(decide({ exposes_secret: noul(0.9) }).action, 'deny');
  assert.equal(decide({ uploads_data: noul(0.45) }).action, 'ask'); // unsure asks
});

test('not requested asks on its own and turns a flagged ask into a deny; unsure requested counts for nothing', () => {
  const a = decide({ requested: noul(0.1) });
  assert.equal(a.action, 'ask');
  assert.equal(a.reason, 'jevgate: asking · not requested');
  assert.deepEqual(a.flags, ['not requested']);
  assert.deepEqual(decide({ requested: noul(0.1), changes_system: noul(0.9) }).flags, ['changes_system', 'not requested']);
  const d = decide({ requested: noul(0.1), changes_system: noul(0.9) });
  assert.equal(d.action, 'deny');
  assert.equal(d.reason, 'jevgate: denied · changes_system, not requested');
  assert.equal(decide({ requested: noul(0.1), changes_system: noul(0.45) }).action, 'ask'); // unsure stays an ask
  assert.equal(decide({ requested: noul(0.4), changes_system: noul(0.9) }).action, 'ask');
  assert.equal(decide({ requested: noul(0.4) }).action, 'allow');
  assert.equal(decideFacts({ requested: 'false' }, mergeRules(DEFAULT_RULES, { requested: { false: 'allow' } }, undefined)).action, 'allow');
});

test('rules: an override per fact value and per mode; unsure outcome is configurable', () => {
  const f: Facts = { deletes: 'local_no_copy', requested: 'true' };
  assert.equal(decideFacts(f).action, 'ask');
  const strict = mergeRules(DEFAULT_RULES, { deletes: { local_no_copy: 'deny' }, modes: { auto: { deletes: { local_no_copy: 'allow' } } } }, 'bypassPermissions');
  assert.equal(decideFacts(f, strict).action, 'deny');
  assert.equal(decideFacts(f, mergeRules(DEFAULT_RULES, { deletes: { local_no_copy: 'deny' }, modes: { auto: { deletes: { local_no_copy: 'allow' } } } }, 'auto')).action, 'allow');
  assert.equal(mergeRules(DEFAULT_RULES, { deletes: { local_no_copy: 'nope' } }, undefined).deletes!.local_no_copy, 'ask');
  assert.equal(DEFAULT_RULES.deletes!.local_no_copy, 'ask', 'defaults are not mutated');
  assert.equal(decideFacts({ uploads_data: 'unsure' }, DEFAULT_RULES, 'deny').action, 'deny');
});

test('rawScores flattens nouls and choice options for the log', () => {
  const s = rawScores(res(), FILE_FACTS);
  assert.deepEqual(Object.keys(s), ['deletes.local_no_copy', 'deletes.remote', 'changes_system', 'requested']);
});

test('config: fact knobs with defaults, known hosts, rules file', () => {
  assert.deepEqual(thresholds(DEFAULTS), DEFAULT_THRESHOLDS);
  const cfg = fromRaw({ hitMin: '0.4', unsureOutcome: 'deny', knownHosts: 'box, arch ,' });
  assert.equal(cfg.hitMin, 0.4);
  assert.equal(cfg.unsureOutcome, 'deny');
  assert.equal(fromRaw({ unsureOutcome: 'maybe' }).unsureOutcome, 'ask');
  assert.deepEqual(knownHosts(cfg), ['box', 'arch']);
  assert.deepEqual(knownHosts(DEFAULTS), []);
  assert.deepEqual(knownHosts(fromEnv({ CLAUDE_PLUGIN_OPTION_KNOWNHOSTS: 'box' })), ['box']);
});
