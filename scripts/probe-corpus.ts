// Live probe of the harm questions over real commands from the local corpus.
// Usage: TYPESAFE_API_KEY=... node scripts/probe-corpus.ts <buckets.jsonl> [--sample N] [--concurrency C] [--out results.jsonl] [--seed S]
//        node scripts/probe-corpus.ts --file tests/fixtures/commands.jsonl [...]
// Free commands are skipped (they never reach Jev). Prints one row per command
// sorted by the highest score, with the category that would deny at defaults.
import { readFileSync, writeFileSync } from 'node:fs';
import { ask, nodeFetch } from '../src/jev.ts';
import { checkFree } from '../src/free.ts';
import { CATEGORIES, DEFAULT_THRESHOLDS, QUESTIONS, decide, type BashState, type Category } from '../src/bash-policy.ts';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY not set');
  process.exit(1);
}
const argv = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : (argv[i + 1] ?? dflt);
};
const file = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]!.startsWith('--'))) ?? opt('--file', '');
const sample = Number(opt('--sample', '25'));
const concurrency = Number(opt('--concurrency', '4'));
const out = opt('--out', '');
const seed = Number(opt('--seed', '1'));

type Row = { cmd: string; bucket?: string; project?: string; recent?: string[]; expect?: string };
type Result = Row & { scores: Record<Category, number>; deny?: Category; ms: number };

const rows: Row[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('{'))
  .map((l) => JSON.parse(l) as Row);

// deterministic shuffle
let s = seed;
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const shuffle = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const seen = new Set<string>();
const judged = rows.filter((r) => {
  if (seen.has(r.cmd) || !r.cmd.trim() || checkFree(r.cmd).free) return false;
  seen.add(r.cmd);
  return true;
});
let picked: Row[];
if (argv.includes('--file')) picked = judged;
else {
  const byBucket = new Map<string, Row[]>();
  for (const r of judged) byBucket.set(r.bucket ?? '?', [...(byBucket.get(r.bucket ?? '?') ?? []), r]);
  picked = [...byBucket.values()].flatMap((rs) => shuffle(rs).slice(0, sample));
}
console.error(`${rows.length} rows, ${judged.length} distinct non-free, probing ${picked.length} (concurrency ${concurrency})`);

const fetchLike = nodeFetch(15000);
const results: Result[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < picked.length) {
    const r = picked[next++]!;
    const state: BashState = { command: r.cmd, cwd: r.project, repo_root: r.project };
    if (r.recent?.length) state.recent = r.recent;
    const t0 = Date.now();
    try {
      const res = await ask(fetchLike, { apiKey: apiKey!, model: process.env.JEV_MODEL ?? 'jev-latest' }, state, QUESTIONS);
      const d = decide(res, DEFAULT_THRESHOLDS);
      results.push({ ...r, scores: d.scores, deny: d.action === 'deny' ? d.category : undefined, ms: Date.now() - t0 });
    } catch (err) {
      console.error(`error on ${JSON.stringify(r.cmd.slice(0, 60))}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (results.length % 25 === 0) console.error(`  ${results.length}/${picked.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const SHORT: Record<Category, string> = {
  destroys_uncommitted_work: 'destr',
  deletes_outside_repo: 'delout',
  rewrites_shared_history: 'hist',
  deploys_or_publishes: 'deploy',
  exfiltrates: 'exfil',
  reads_secrets: 'secret',
  escalates_or_system: 'system',
  exceeds_request: 'exceed',
};
const max = (r: Result) => Math.max(...CATEGORIES.filter((c) => c !== 'exceeds_request').map((c) => r.scores[c]));
results.sort((a, b) => max(b) - max(a));
const one = (c: string) => JSON.stringify(c.length > 90 ? c.slice(0, 90) + '…' : c);
console.log(['deny  ', ...CATEGORIES.map((c) => SHORT[c].padStart(6)), ' bucket           ', 'command'].join(' '));
for (const r of results) {
  console.log(
    [
      (r.deny ? SHORT[r.deny] : '').padEnd(6),
      ...CATEGORIES.map((c) => r.scores[c].toFixed(2).padStart(6)),
      ` ${(r.bucket ?? '').padEnd(18)}`,
      one(r.cmd),
      r.expect ? `  [expect ${r.expect}]` : '',
    ].join(' '),
  );
}
const denied = results.filter((r) => r.deny);
console.log(`\n${results.length} judged, ${denied.length} would be denied at defaults; avg ${Math.round(results.reduce((a, r) => a + r.ms, 0) / Math.max(1, results.length))}ms`);
for (const c of CATEGORIES) {
  const n = denied.filter((r) => r.deny === c).length;
  if (n) console.log(`  ${c}: ${n}`);
}
if (out) writeFileSync(out, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
