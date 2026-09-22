// Compare `isFree` with analyze2's FREE bucket over the local corpus.
// Usage: node scripts/free-corpus.ts <buckets.jsonl> [--show N]
// The JSONL comes from scripts/session-analysis/dump_buckets.py.
import { readFileSync } from 'node:fs';
import { checkFree } from '../src/free.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/free-corpus.ts <buckets.jsonl> [--show N]');
  process.exit(1);
}
const showIdx = process.argv.indexOf('--show');
const show = showIdx === -1 ? 8 : Number(process.argv[showIdx + 1] ?? 8);

type Row = { cmd: string; bucket: string };
const rows: Row[] = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.startsWith('{'))
  .map((l) => JSON.parse(l) as Row);

let free = 0;
let a2free = 0;
let both = 0;
const looser: [string, string][] = []; // isFree yes, analyze2 no  (the risky direction)
const stricter = new Map<string, string[]>(); // analyze2 FREE, isFree no, by reason
for (const r of rows) {
  const c = checkFree(r.cmd);
  const a2 = r.bucket === 'FREE';
  if (c.free) free++;
  if (a2) a2free++;
  if (c.free && a2) both++;
  else if (c.free && !a2) looser.push([r.bucket, r.cmd]);
  else if (!c.free && a2) {
    const key = (c.reason ?? '?').split(' ').slice(0, 2).join(' ');
    const list = stricter.get(key) ?? [];
    list.push(r.cmd);
    stricter.set(key, list);
  }
}
const pct = (n: number) => `${((100 * n) / rows.length).toFixed(1)}%`;
console.log(`commands ${rows.length}`);
console.log(`isFree   ${free} (${pct(free)})`);
console.log(`analyze2 FREE ${a2free} (${pct(a2free)})`);
console.log(`agree free ${both}; isFree only ${looser.length}; analyze2 only ${rows.length - free - a2free + both === rows.length ? 0 : a2free - both}`);

const one = (s: string) => JSON.stringify(s.length > 110 ? s.slice(0, 110) + '…' : s);
console.log(`\n== free here, not FREE in analyze2 (${looser.length}) ==`);
const byBucket = new Map<string, string[]>();
for (const [b, c] of looser) byBucket.set(b, [...(byBucket.get(b) ?? []), c]);
for (const [b, cs] of [...byBucket].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`-- ${b} (${cs.length})`);
  for (const c of cs.slice(0, show)) console.log('   ' + one(c));
}
console.log(`\n== FREE in analyze2, not free here, by reason ==`);
for (const [k, cs] of [...stricter].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`-- ${k} (${cs.length})`);
  for (const c of cs.slice(0, show)) console.log('   ' + one(c));
}
