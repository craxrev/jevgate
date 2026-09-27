// Layer-2 probe: real Jev, hand-written inputs. Prints scores so thresholds
// and question wording can be tuned from data. Usage: TYPESAFE_API_KEY=... node scripts/probe.ts [done|agent|all]
// The Bash and file guards' facts have their own probe: scripts/probe-facts.ts.
import { ask } from '../src/jev.ts';
import { nodeFetch } from '../src/node-fetch.ts';
import * as done from '../src/done-policy.ts';
import * as agent from '../src/agent-policy.ts';
import { DONE_CASES } from './done-cases.ts';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY not set');
  process.exit(1);
}
const opts = { apiKey, model: process.env.JEV_MODEL ?? 'jev-latest' };
const fetchLike = nodeFetch(8000);
const which = process.argv[2] ?? 'all';

const fmt = (n: number) => n.toFixed(2).padStart(5);

async function probeDone() {
  console.log('\n== done check ==');
  for (const c of DONE_CASES) {
    const t0 = Date.now();
    const res = await ask(fetchLike, opts, c.state, done.QUESTIONS);
    const d = done.decide(res, { coverMin: 2.5, claimsMin: 0.5 });
    const s = d.scores;
    console.log(
      `${c.expect.padEnd(6)} ${d.action.padEnd(6)} coverage ${fmt(s.coverage!)}/3 claims ${fmt(s.claims_backed!)} asks ${fmt(s.asks_user!)}  ${c.name} (${Date.now() - t0}ms)${d.action === c.expect ? '' : '   <-- MISMATCH'}`,
    );
  }
}

async function probeAgent() {
  console.log('\n== agent gate ==');
  const recent = [
    { role: 'user' as const, text: 'What does the DEFAULTS.compactAtPercent value do?' },
    { role: 'assistant' as const, text: 'It is the context percentage at which the turn.complete hook requests compaction. Default 60. Defined in src/config.ts.' },
    { role: 'user' as const, text: 'ok and where is it read?' },
  ];
  const cases: { name: string; input: { subagent_type: string; description: string; prompt: string }; expect: 'deny' | 'pass' }[] = [
    {
      name: 'redundant',
      expect: 'deny',
      input: { subagent_type: 'Explore', description: 'Find compactAtPercent default', prompt: 'Search the codebase for the default value of compactAtPercent and report it.' },
    },
    {
      name: 'genuine',
      expect: 'pass',
      input: { subagent_type: 'Explore', description: 'Find readers of compactAtPercent', prompt: 'Search the codebase for every place compactAtPercent is read and list file:line.' },
    },
  ];
  for (const c of cases) {
    const t0 = Date.now();
    const res = await ask(fetchLike, opts, agent.buildState(recent, c.input), agent.QUESTIONS);
    const d = agent.decide(res, 0.95);
    console.log(`${c.expect.padEnd(5)} ${d.action.padEnd(5)} in_context ${fmt(d.scores.in_context!)}  ${c.name} (${Date.now() - t0}ms)${d.action === c.expect ? '' : '   <-- MISMATCH'}`);
  }
}

if (which === 'done' || which === 'all') await probeDone();
if (which === 'agent' || which === 'all') await probeAgent();
