import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Decision = {
  feature: 'bash' | 'file' | 'done' | 'agent' | 'compact';
  action: string;
  session?: string;
  [k: string]: unknown;
};

export function formatEntry(d: Decision, now = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), ...d }) + '\n';
}

/** Best-effort append; a logging failure must never affect the hook decision. */
export function appendLog(path: string, d: Decision): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatEntry(d));
  } catch {
    // ignore
  }
}
