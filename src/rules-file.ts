// The rules file, read by the command hooks only: the function-hook module may
// not import node: builtins, so this stays out of config.ts.
import { readFileSync } from 'node:fs';
import { DEFAULT_RULES, mergeRules, type Rules } from './facts.ts';
import type { Config } from './config.ts';

/** The default rules with the rules file on top; a missing or broken file keeps the defaults. */
export function rules(cfg: Config, mode: string | undefined): Rules {
  if (!cfg.rulesFile) return DEFAULT_RULES;
  try {
    return mergeRules(DEFAULT_RULES, JSON.parse(readFileSync(cfg.rulesFile, 'utf8')), mode);
  } catch {
    return DEFAULT_RULES;
  }
}
