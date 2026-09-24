// No node: imports here: the function-hook module (hooks/compact.ts) loads this file.
import { DEFAULT_THRESHOLDS, type Outcome, type Thresholds } from './facts.ts';

export type Config = {
  apiKey?: string;
  model: string;
  timeoutMs: number;
  /** The full decisions log (commands, paths, Jev's facts); the stats the UI reads are kept either way. */
  log: boolean;

  bashEnabled: boolean;
  bashRecentTurns: number;

  fileEnabled: boolean;

  /** Shared by both guards: see Thresholds in facts.ts. */
  hitMin: number;
  noneMin: number;
  requestedMin: number;
  unrequestedMax: number;
  /** Outcome when Jev is unsure about a fact. */
  unsureOutcome: Outcome;
  /** Comma-separated hosts the user owns; uploads to them are not flagged. */
  knownHosts: string;
  /** JSON file whose entries override the outcome per fact value, optionally per mode. */
  rulesFile?: string;

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
  log: false,

  bashEnabled: true,
  bashRecentTurns: 8,

  fileEnabled: true,

  hitMin: DEFAULT_THRESHOLDS.hitMin,
  noneMin: DEFAULT_THRESHOLDS.noneMin,
  requestedMin: DEFAULT_THRESHOLDS.requestedMin,
  unrequestedMax: DEFAULT_THRESHOLDS.unrequestedMax,
  unsureOutcome: 'ask',
  knownHosts: '',

  doneEnabled: false,
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

function outcome(v: unknown, fallback: Outcome): Outcome {
  return v === 'allow' || v === 'ask' || v === 'deny' ? v : fallback;
}

/** Builds a Config from raw option values keyed by camelCase option name. */
export function fromRaw(raw: Raw): Config {
  const d = DEFAULTS;
  return {
    apiKey: str(raw.apiKey),
    model: str(raw.model) ?? d.model,
    timeoutMs: num(raw.timeoutMs, d.timeoutMs),
    log: bool(raw.log, d.log),

    bashEnabled: bool(raw.bashEnabled, d.bashEnabled),
    bashRecentTurns: num(raw.bashRecentTurns, d.bashRecentTurns),

    fileEnabled: bool(raw.fileEnabled, d.fileEnabled),

    hitMin: num(raw.hitMin, d.hitMin),
    noneMin: num(raw.noneMin, d.noneMin),
    requestedMin: num(raw.requestedMin, d.requestedMin),
    unrequestedMax: num(raw.unrequestedMax, d.unrequestedMax),
    unsureOutcome: outcome(raw.unsureOutcome, d.unsureOutcome),
    knownHosts: str(raw.knownHosts) ?? d.knownHosts,
    rulesFile: str(raw.rulesFile),

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
  if (env[OPTION_PREFIX + 'RULESFILE']) raw.rulesFile = env[OPTION_PREFIX + 'RULESFILE'];
  const cfg = fromRaw(raw);
  cfg.apiKey = cfg.apiKey ?? env.TYPESAFE_API_KEY;
  return cfg;
}

export function thresholds(cfg: Config): Thresholds {
  return { hitMin: cfg.hitMin, noneMin: cfg.noneMin, requestedMin: cfg.requestedMin, unrequestedMax: cfg.unrequestedMax };
}

export function knownHosts(cfg: Config): string[] {
  return cfg.knownHosts.split(',').map((h) => h.trim()).filter(Boolean);
}
