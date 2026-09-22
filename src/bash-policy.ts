import type { Questions, JevResponse } from './jev.ts';
import { noul } from './jev.ts';

/**
 * Commands jevgate never asks Jev about ("not-asked"). They continue through
 * the normal permission flow untouched. Conservative on purpose: Jev only sees
 * the command text. Each rule carries a name so the log says which one tripped.
 */
export const NEVER_ASK: { name: string; re: RegExp }[] = [
  { name: 'git-write', re: /\bgit\s+(push|reset|clean|checkout|restore|switch|rebase|merge|commit|cherry-pick|revert|stash|tag|remote|config|filter-branch|gc|prune)\b/ },
  { name: 'git-branch-delete', re: /\bgit\s+branch\s+.*-[dDmM]\b/ },
  { name: 'file-write', re: /\b(rm|rmdir|mv|cp|dd|shred|truncate|touch|mkdir|ln|chmod|chown|chgrp)\b/ },
  { name: 'network', re: /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp)\b/ },
  { name: 'privilege', re: /\b(sudo|su|doas)\b/ },
  { name: 'system', re: /\b(kill|killall|pkill|reboot|shutdown|launchctl|crontab|systemctl|service)\b/ },
  { name: 'package-manager', re: /\b(npm|pnpm|yarn|bun)\s+(publish|install|i|ci|add|remove|rm|uninstall|link|unlink|update|upgrade|exec|x|create|init|login|logout|deprecate|version)\b/ },
  { name: 'package-runner', re: /\b(npx|bunx|pipx|uvx)\b/ },
  { name: 'package-manager', re: /\b(pip3?|uv|poetry|cargo|gem|go)\s+(install|add|remove|uninstall|publish|push)\b/ },
  { name: 'system-package', re: /\b(brew|apt|apt-get|yum|dnf|pacman|port)\b/ },
  { name: 'infra-cli', re: /\b(docker|podman|kubectl|helm|terraform|pulumi|ansible|vagrant)\b/ },
  { name: 'cloud-cli', re: /\b(aws|gcloud|az|doctl|heroku|vercel|netlify|fly|wrangler|gh\s+api)\b/ },
  { name: 'gh-write', re: /\bgh\s+(pr|issue|release|repo|gist|secret|variable)\s+(create|edit|close|merge|delete|comment|reopen|set|remove)\b/ },
  { name: 'shell-builtin', re: /\b(eval|exec|source|export|unset|alias|trap)\b/ },
  { name: 'shell-builtin', re: /^\s*\.\s/ },
  { name: 'pipe-to-interpreter', re: /\|\s*(sh|bash|zsh|fish|python3?|node|deno|bun|perl|ruby)\b/ },
  { name: 'in-place-edit', re: /\b(sed|perl)\s+(-[a-zA-Z]*i|--in-place)\b/ },
  { name: 'in-place-edit', re: /\btee\b/ },
  { name: 'system', re: /\bdefaults\s+write\b/ },
  { name: 'open', re: /\bopen\b/ },
  { name: 'claude-cli', re: /\bclaude\b/ },
  { name: 'secrets', re: /\.env\b/ },
  { name: 'secrets', re: /(secret|token|passw(or)?d|credential|api[_-]?key|private[_-]?key)/i },
  { name: 'dotfiles', re: /~\/\.(ssh|aws|gnupg|config|claude|npmrc|netrc)/ },
  { name: 'dotfiles', re: /\$\{?HOME\}?\/\.(ssh|aws|gnupg|config|claude)/ },
];

const HARMLESS_REDIRECTS = /(\d?>\s*\/dev\/null|2>&1|&>\s*\/dev\/null)/g;

/** The never-ask rule a command trips, or undefined when Jev may be asked. */
export function neverAskReason(command: string): string | undefined {
  if (command.length > 2000) return 'too-long';
  const stripped = command.replace(HARMLESS_REDIRECTS, '');
  if (/>/.test(stripped)) return 'redirect';
  return NEVER_ASK.find((r) => r.re.test(command))?.name;
}

/** True when the command must skip Jev entirely. */
export function isPassthrough(command: string): boolean {
  return neverAskReason(command) !== undefined;
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

/** `fast-lane`: Jev approved, the call skips the normal review. `unsure`: asked, not confident, normal flow. */
export type BashDecision =
  | { action: 'fast-lane'; reason: string; scores: Record<string, number> }
  | { action: 'unsure'; reason: string; scores: Record<string, number> };

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
    return { action: 'fast-lane', reason: `jevgate ${readOnly ? 'read-only' : 'dev-task'}: ${summary}`, scores };
  }
  return { action: 'unsure', reason: `below threshold: ${summary}`, scores };
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
