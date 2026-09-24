import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataDir, type Config } from './config.ts';

export type Decision = {
  feature: 'bash' | 'file' | 'done' | 'agent' | 'compact';
  action: string;
  session?: string;
  [k: string]: unknown;
};

/** What the footer, row lines and /jevgate read: no commands, paths or prompts. */
export const STATS_FIELDS = ['ts', 'feature', 'action', 'session', 'tool_use_id', 'category', 'reason', 'ms', 'prepMs', 'connectMs', 'serverMs', 'tries'] as const;

export function statsEntry(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of STATS_FIELDS) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

export function formatEntry(d: Record<string, unknown>, now = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), ...d }) + '\n';
}

/** Best-effort append, owner-only when it creates the file; a logging failure must never affect the hook decision. */
function append(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // ignore
  }
}

/**
 * Once per data dir: stats.jsonl starts as the stats fields of the old full log, so
 * all-time counts carry over. Written aside and linked in, so of two hooks racing
 * to seed, one wins and the other's line lands after the seed.
 */
export function seedStats(dir: string): void {
  const stats = `${dir}/stats.jsonl`;
  if (existsSync(stats)) return;
  try {
    mkdirSync(dir, { recursive: true });
    // the UI module writes ui.jsonl with no say over its mode: create it owner-only first
    closeSync(openSync(`${dir}/ui.jsonl`, 'a', 0o600));
    const old = `${dir}/decisions-v2.jsonl`;
    if (!existsSync(old)) return;
    chmodSync(old, 0o600);
    const seed = readFileSync(old, 'utf8')
      .split('\n')
      .flatMap((l) => {
        if (!l.startsWith('{')) return [];
        try {
          return [JSON.stringify(statsEntry(JSON.parse(l) as Record<string, unknown>)) + '\n'];
        } catch {
          return [];
        }
      })
      .join('');
    const tmp = `${stats}.${process.pid}.tmp`;
    writeFileSync(tmp, seed, { mode: 0o600 });
    try {
      linkSync(tmp, stats);
    } finally {
      unlinkSync(tmp);
    }
  } catch {
    // another hook seeded first, or the dir is unwritable: appending still works
  }
}

export type Log = (d: Decision) => void;

/** The command hooks' log: stats fields always, the full entry only with the `log` option on. */
export function logger(env: Record<string, string | undefined>, cfg: Pick<Config, 'log' | 'logPath'>): Log {
  const dir = dataDir(env);
  const detail = cfg.logPath ?? `${dir}/decisions-v2.jsonl`;
  return (d) => {
    const now = new Date();
    seedStats(dir);
    append(`${dir}/stats.jsonl`, formatEntry(statsEntry(d), now));
    if (cfg.log) append(detail, formatEntry(d, now));
  };
}
