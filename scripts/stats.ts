// Prints the bash guard tally for the /jevgate command: current session (the
// newest session in the log, or --session <id>) and all-time.
import { readFileSync, existsSync } from 'node:fs';
import { parseLog, bashStats, latestSession, formatStats } from '../src/ui-model.ts';

const home = process.env.HOME ?? '.';
const candidates = [
  process.env.CLAUDE_PLUGIN_DATA ? `${process.env.CLAUDE_PLUGIN_DATA}/decisions.jsonl` : undefined,
  `${home}/.claude/plugins/data/jevgate-jevgate/decisions.jsonl`,
  `${home}/.claude/jevgate/decisions.jsonl`,
].filter((p): p is string => !!p);
const path = candidates.find((p) => existsSync(p));
if (!path) {
  console.log(`jevgate: no decisions log yet (looked in ${candidates.join(', ')})`);
  process.exit(0);
}
const entries = parseLog(readFileSync(path, 'utf8'));
const i = process.argv.indexOf('--session');
const session = i === -1 ? latestSession(entries) : process.argv[i + 1];
console.log(formatStats(bashStats(entries, session), bashStats(entries), session));
console.log(`log: ${path} (${entries.length} entries)`);
