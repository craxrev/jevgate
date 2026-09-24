// Prints the bash guard tally for the /jevgate command: current session (the
// newest session in the log, or --session <id>) and all-time.
import { readFileSync, existsSync } from 'node:fs';
import { parseLog, bashStats, latestSession, formatStats } from '../src/ui-model.ts';

const home = process.env.HOME ?? '.';
const dirs = [`${home}/.claude/jevgate`].filter((d) => existsSync(`${d}/stats.jsonl`));
if (!dirs.length) {
  console.log('jevgate: no stats log yet');
  process.exit(0);
}
const read = (p: string) => (existsSync(p) ? parseLog(readFileSync(p, 'utf8')) : []);
const entries = dirs.flatMap((d) => read(`${d}/stats.jsonl`)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
const i = process.argv.indexOf('--session');
const session = i === -1 ? latestSession(entries) : process.argv[i + 1];
console.log(formatStats(bashStats(entries, session), bashStats(entries), session));
console.log(`log: ${dirs.join(', ')} (${entries.length} entries)`);

// free calls Claude Code's classifier judged anyway: gaps between the free set and Claude Code's own
const slipped = entries.filter((e) => e.action === 'slipped');
if (slipped.length) {
  const full = new Map(dirs.flatMap((d) => read(`${d}/decisions-v2.jsonl`)).map((e) => [e.tool_use_id, e]));
  console.log(`\nslipped to the classifier: ${slipped.length}`);
  for (const e of slipped.slice(-20)) {
    const f = full.get(e.tool_use_id);
    console.log(`  ${e.ts.slice(0, 16)}  ${f?.command ?? f?.path ?? `(${e.tool_use_id}; the command is in the full log when it is on)`}`);
  }
}
