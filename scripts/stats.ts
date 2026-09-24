// Prints the bash guard tally for the /jevgate command: current session (the
// newest session in the log, or --session <id>) and all-time.
import { readFileSync, existsSync } from 'node:fs';
import { parseLog, bashStats, latestSession, formatStats } from '../src/ui-model.ts';

const home = process.env.HOME ?? '.';
const dirs = [
  process.env.CLAUDE_PLUGIN_DATA,
  `${home}/.claude/plugins/data/jevgate-jevgate`,
  `${home}/.claude/plugins/data/jevgate-inline`,
  `${home}/.claude/jevgate`,
].filter((p): p is string => !!p);
const dir = dirs.find((d) => existsSync(`${d}/stats.jsonl`));
if (!dir) {
  console.log(`jevgate: no stats log yet (looked in ${dirs.join(', ')})`);
  process.exit(0);
}
const read = (p: string) => (existsSync(p) ? parseLog(readFileSync(p, 'utf8')) : []);
const entries = [...read(`${dir}/stats.jsonl`), ...read(`${dir}/ui.jsonl`)].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
const i = process.argv.indexOf('--session');
const session = i === -1 ? latestSession(entries) : process.argv[i + 1];
console.log(formatStats(bashStats(entries, session), bashStats(entries), session));
console.log(`log: ${dir}/stats.jsonl + ui.jsonl (${entries.length} entries)`);
