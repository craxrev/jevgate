import type { BashThresholds } from './bash-policy.ts';

export type Config = {
  apiKey?: string;
  model: string;
  timeoutMs: number;
  logPath?: string;

  bashEnabled: boolean;
  bashRecentTurns: number;
  /** Allow (skip the classifier) when every deny category scores under this; 0 disables. */
  bashAllowMax: number;
  /** Deny thresholds per harm category; 0 means log only. */
  bashDenyDestroy: number;
  bashDenyDeleteOutside: number;
  bashDenyHistory: number;
  bashDenyDeploy: number;
  bashDenyExfil: number;
  bashDenySecrets: number;
  bashDenySystem: number;
  bashDenyExceeds: number;

  fileEnabled: boolean;
  fileDenySystem: number;
  fileDenyExceeds: number;

  doneEnabled: boolean;
  doneMaxBlocks: number;
  /** Coverage level (0 none … 3 all) below which the stop is blocked. */
  doneCoverMin: number;
  doneClaimsMin: number;
  doneLeftoverMax: number;
  doneDiffMaxChars: number;

  agentEnabled: boolean;
  agentThreshold: number;
  agentRecentTurns: number;

  compactEnabled: boolean;
  compactUseJev: boolean;
  compactAtPercent: number;
  compactPreserveRecent: number;
  compactTruncateHeadChars: number;
  compactRestoreTopK: number;
  /** Share of the Choice mass a candidate needs to be restored. */
  compactRestoreMinScore: number;
  /** Jev's Choice confidence must reach this before anything is restored; 0 disables the gate. */
  compactRestoreMinConfidence: number;
  compactMinReductionRatio: number;
};

export const DEFAULTS: Config = {
  model: 'jev-latest',
  timeoutMs: 4000,

  bashEnabled: true,
  bashRecentTurns: 8,
  bashAllowMax: 0.3,
  bashDenyDestroy: 0.5,
  bashDenyDeleteOutside: 0.5,
  bashDenyHistory: 0.5,
  bashDenyDeploy: 0.6,
  bashDenyExfil: 0.6,
  bashDenySecrets: 0.6,
  bashDenySystem: 0.7,
  bashDenyExceeds: 0,

  fileEnabled: true,
  fileDenySystem: 0.6,
  fileDenyExceeds: 0,

  doneEnabled: true,
  doneMaxBlocks: 2,
  doneCoverMin: 2.5,
  doneClaimsMin: 0.5,
  doneLeftoverMax: 0.9,
  doneDiffMaxChars: 60000,

  agentEnabled: true,
  agentThreshold: 0.95,
  agentRecentTurns: 12,

  compactEnabled: true,
  compactUseJev: true,
  compactAtPercent: 60,
  compactPreserveRecent: 6,
  compactTruncateHeadChars: 300,
  compactRestoreTopK: 5,
  compactRestoreMinScore: 0.1,
  compactRestoreMinConfidence: 0,
  compactMinReductionRatio: 0.25,
};

type Raw = Record<string, string | number | boolean | readonly string[] | undefined>;

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
  }
  return fallback;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Builds a Config from raw option values keyed by camelCase option name. */
export function fromRaw(raw: Raw): Config {
  const d = DEFAULTS;
  return {
    apiKey: str(raw.apiKey),
    model: str(raw.model) ?? d.model,
    timeoutMs: num(raw.timeoutMs, d.timeoutMs),
    logPath: str(raw.logPath),

    bashEnabled: bool(raw.bashEnabled, d.bashEnabled),
    bashRecentTurns: num(raw.bashRecentTurns, d.bashRecentTurns),
    bashAllowMax: num(raw.bashAllowMax, d.bashAllowMax),
    bashDenyDestroy: num(raw.bashDenyDestroy, d.bashDenyDestroy),
    bashDenyDeleteOutside: num(raw.bashDenyDeleteOutside, d.bashDenyDeleteOutside),
    bashDenyHistory: num(raw.bashDenyHistory, d.bashDenyHistory),
    bashDenyDeploy: num(raw.bashDenyDeploy, d.bashDenyDeploy),
    bashDenyExfil: num(raw.bashDenyExfil, d.bashDenyExfil),
    bashDenySecrets: num(raw.bashDenySecrets, d.bashDenySecrets),
    bashDenySystem: num(raw.bashDenySystem, d.bashDenySystem),
    bashDenyExceeds: num(raw.bashDenyExceeds, d.bashDenyExceeds),

    fileEnabled: bool(raw.fileEnabled, d.fileEnabled),
    fileDenySystem: num(raw.fileDenySystem, d.fileDenySystem),
    fileDenyExceeds: num(raw.fileDenyExceeds, d.fileDenyExceeds),

    doneEnabled: bool(raw.doneEnabled, d.doneEnabled),
    doneMaxBlocks: num(raw.doneMaxBlocks, d.doneMaxBlocks),
    doneCoverMin: num(raw.doneCoverMin, d.doneCoverMin),
    doneClaimsMin: num(raw.doneClaimsMin, d.doneClaimsMin),
    doneLeftoverMax: num(raw.doneLeftoverMax, d.doneLeftoverMax),
    doneDiffMaxChars: num(raw.doneDiffMaxChars, d.doneDiffMaxChars),

    agentEnabled: bool(raw.agentEnabled, d.agentEnabled),
    agentThreshold: num(raw.agentThreshold, d.agentThreshold),
    agentRecentTurns: num(raw.agentRecentTurns, d.agentRecentTurns),

    compactEnabled: bool(raw.compactEnabled, d.compactEnabled),
    compactUseJev: bool(raw.compactUseJev, d.compactUseJev),
    compactAtPercent: num(raw.compactAtPercent, d.compactAtPercent),
    compactPreserveRecent: num(raw.compactPreserveRecent, d.compactPreserveRecent),
    compactTruncateHeadChars: num(raw.compactTruncateHeadChars, d.compactTruncateHeadChars),
    compactRestoreTopK: num(raw.compactRestoreTopK, d.compactRestoreTopK),
    compactRestoreMinScore: num(raw.compactRestoreMinScore, d.compactRestoreMinScore),
    compactRestoreMinConfidence: num(raw.compactRestoreMinConfidence, d.compactRestoreMinConfidence),
    compactMinReductionRatio: num(raw.compactMinReductionRatio, d.compactMinReductionRatio),
  };
}

const OPTION_PREFIX = 'CLAUDE_PLUGIN_OPTION_';

/** Command hooks: options arrive as CLAUDE_PLUGIN_OPTION_<KEY> (key uppercased). */
export function fromEnv(env: Record<string, string | undefined>): Config {
  const raw: Raw = {};
  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    const v = env[OPTION_PREFIX + key.toUpperCase()];
    if (v !== undefined) raw[key] = v;
  }
  if (env[OPTION_PREFIX + 'APIKEY']) raw.apiKey = env[OPTION_PREFIX + 'APIKEY'];
  if (env[OPTION_PREFIX + 'LOGPATH']) raw.logPath = env[OPTION_PREFIX + 'LOGPATH'];
  const cfg = fromRaw(raw);
  cfg.apiKey = cfg.apiKey ?? env.TYPESAFE_API_KEY;
  return cfg;
}

/** The per-category deny thresholds as the bash policy wants them. */
export function bashThresholds(cfg: Config): BashThresholds {
  return {
    destroys_uncommitted_work: cfg.bashDenyDestroy,
    deletes_outside_repo: cfg.bashDenyDeleteOutside,
    rewrites_shared_history: cfg.bashDenyHistory,
    deploys_or_publishes: cfg.bashDenyDeploy,
    exfiltrates: cfg.bashDenyExfil,
    reads_secrets: cfg.bashDenySecrets,
    escalates_or_system: cfg.bashDenySystem,
    exceeds_request: cfg.bashDenyExceeds,
  };
}

export function defaultLogPath(env: Record<string, string | undefined>): string {
  const base = env.CLAUDE_PLUGIN_DATA ?? `${env.HOME ?? '.'}/.claude/jevgate`;
  return `${base}/decisions.jsonl`;
}
