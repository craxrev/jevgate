import type { Questions, JevResponse } from './jev.ts';
import { noul } from './jev.ts';

/**
 * Commands jevgate never pre-approves. They continue through the normal
 * permission flow untouched. Conservative on purpose: Jev only sees the command text.
 */
export const PASSTHROUGH: RegExp[] = [
  /\bgit\s+(push|reset|clean|checkout|restore|switch|rebase|merge|commit|cherry-pick|revert|stash|tag|remote|config|filter-branch|gc|prune)\b/,
  /\bgit\s+branch\s+.*-[dDmM]\b/,
  /\b(rm|rmdir|mv|cp|dd|shred|truncate|touch|mkdir|ln|chmod|chown|chgrp)\b/,
  /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp)\b/,
  /\b(sudo|su|doas)\b/,
  /\b(kill|killall|pkill|reboot|shutdown|launchctl|crontab|systemctl|service)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(publish|install|i|ci|add|remove|rm|uninstall|link|unlink|update|upgrade|exec|x|create|init|login|logout|deprecate|version)\b/,
  /\b(npx|bunx|pipx|uvx)\b/,
  /\b(pip3?|uv|poetry|cargo|gem|go)\s+(install|add|remove|uninstall|publish|push)\b/,
  /\b(brew|apt|apt-get|yum|dnf|pacman|port)\b/,
  /\b(docker|podman|kubectl|helm|terraform|pulumi|ansible|vagrant)\b/,
  /\b(aws|gcloud|az|doctl|heroku|vercel|netlify|fly|wrangler|gh\s+api)\b/,
  /\bgh\s+(pr|issue|release|repo|gist|secret|variable)\s+(create|edit|close|merge|delete|comment|reopen|set|remove)\b/,
  /\b(eval|exec|source|export|unset|alias|trap)\b/,
  /^\s*\.\s/,
  /\|\s*(sh|bash|zsh|fish|python3?|node|deno|bun|perl|ruby)\b/,
  /\b(sed|perl)\s+(-[a-zA-Z]*i|--in-place)\b/,
  /\btee\b/,
  /\bdefaults\s+write\b/,
  /\bopen\b/,
  /\bclaude\b/,
  /\.env\b/,
  /(secret|token|passw(or)?d|credential|api[_-]?key|private[_-]?key)/i,
  /~\/\.(ssh|aws|gnupg|config|claude|npmrc|netrc)/,
  /\$\{?HOME\}?\/\.(ssh|aws|gnupg|config|claude)/,
];

const HARMLESS_REDIRECTS = /(\d?>\s*\/dev\/null|2>&1|&>\s*\/dev\/null)/g;

/** True when the command must skip Jev entirely. */
export function isPassthrough(command: string): boolean {
  if (command.length > 2000) return true;
  const stripped = command.replace(HARMLESS_REDIRECTS, '');
  if (/>/.test(stripped)) return true;
  return PASSTHROUGH.some((re) => re.test(command));
}

export type BashState = {
  command: string;
  description?: string;
  cwd?: string;
  segments: string[];
};

export function buildState(input: { command: string; description?: string }, cwd?: string): BashState {
  return {
    command: input.command,
    description: input.description,
    cwd,
    segments: input.command
      .split(/\s*(?:&&|\|\||;|\|)\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const FILTERS =
  'Piping into output filters such as head, tail, grep, wc, sort, uniq, cut, awk, jq, cat, less, column or tr only formats the output and does not change the answer. `description` is the assistant\'s stated intent for the command.';

export const QUESTIONS: Questions = {
  read_only: {
    type: 'noul',
    instructions:
      'The `command` (see `segments`) only inspects state: it reads or prints files, lists directories, searches text, shows environment or version information, or shows git state with status, log, diff, show, blame or ls-files. Nothing is created, modified, moved, or deleted, git state is unchanged, and nothing reaches the network. ' +
      FILTERS,
    criteria: {
      true: 'Purely observational, safe to run any number of times, e.g. `git status`, `ls -la`, `grep -rn foo src/`, `cat package.json`, `wc -l $(git ls-files "*.ts")`.',
      false: 'At least one segment writes, deletes, changes git state, or uses the network.',
    },
  },
  dev_task: {
    type: 'noul',
    instructions:
      'The `command` (see `segments`) runs the current project\'s own test suite, type checker, linter, formatter check, or local build through its standard entry point, such as `npm test`, `npm run lint`, `node --test`, `pytest`, `go test`, `cargo check`, `tsc --noEmit`, `eslint .`, `ruff check`, `make test`. It does not install dependencies, publish, deploy, start a long-running server, or run a one-off script by path. ' +
      FILTERS,
    criteria: {
      true: 'A routine local test, lint, typecheck, format-check, or build invocation.',
      false: 'Something else, a server, or a script whose behavior is unknown.',
    },
  },
  unsafe: {
    type: 'noul',
    instructions:
      'Beyond the ordinary effects of running a project\'s own tests, linters, type checkers or build (writing to build, cache, coverage or test-output directories), the `command` could delete or overwrite source or user files, rewrite git history or remotes, upload data or install software over the network, alter system or shell configuration, or read credentials or secrets.',
    criteria: {
      true: 'A plausible harmful side effect beyond normal test/build output.',
      false: 'No harmful side effect beyond normal test/build output, or purely observational.',
    },
  },
};

export type BashDecision =
  | { action: 'allow'; reason: string; scores: Record<string, number> }
  | { action: 'pass'; reason: string; scores: Record<string, number> };

export type BashThresholds = {
  /** Minimum read_only or dev_task probability. */
  threshold: number;
  /** Test/build runners execute project scripts, so Jev keeps `unsafe` around 0.2-0.5 for them. */
  devUnsafeMax: number;
};

export function decide(res: JevResponse, t: BashThresholds): BashDecision {
  const scores = {
    read_only: noul(res, 'read_only'),
    dev_task: noul(res, 'dev_task'),
    unsafe: noul(res, 'unsafe'),
  };
  const readOnly = scores.read_only >= t.threshold && scores.unsafe <= 1 - t.threshold;
  const devTask = scores.dev_task >= t.threshold && scores.unsafe <= t.devUnsafeMax;
  const summary = `read-only ${scores.read_only.toFixed(2)}, dev-task ${scores.dev_task.toFixed(2)}, unsafe ${scores.unsafe.toFixed(2)}`;
  if (readOnly || devTask) {
    return { action: 'allow', reason: `jevgate ${readOnly ? 'read-only' : 'dev-task'}: ${summary}`, scores };
  }
  return { action: 'pass', reason: `below threshold: ${summary}`, scores };
}

export function allowOutput(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  };
}
