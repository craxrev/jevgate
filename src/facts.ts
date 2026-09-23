// Facts shared by the Bash and file guards. Jev reports what an action does;
// the outcome (allow, ask, deny) is decided here from config, never by Jev.
// Each choice question has one option per outcome tier: options that shared a
// tier confused Jev and changed nothing. Texts are calibrated on the probe
// corpus; changing one means re-measuring it (scripts/probe-facts.ts).
import type { JevResponse, Question, Questions } from './jev.ts';

export type Outcome = 'allow' | 'ask' | 'deny';
const RANK: Record<Outcome, number> = { allow: 0, ask: 1, deny: 2 };

export const CHOICE_FACTS = { deletes: ['remote', 'local_no_copy'], ships: ['public_permanent', 'live_reversible'] } as const;
export const NOUL_FACTS = ['changes_system', 'rewrites_history', 'uploads_data', 'exposes_secret'] as const;
export type Fact = keyof typeof CHOICE_FACTS | (typeof NOUL_FACTS)[number] | 'requested';
export const FACTS: readonly Fact[] = ['deletes', 'ships', ...NOUL_FACTS, 'requested'];

/** Which facts each guard asks: a file write cannot ship, rewrite history or print. */
export const BASH_FACTS: readonly Fact[] = FACTS;
export const FILE_FACTS: readonly Fact[] = ['deletes', 'changes_system', 'requested'];

/** A resolved fact: an option id for choices, 'true'/'false' for nouls, or 'unsure'. */
export type Value = string;
export type Facts = Partial<Record<Fact, Value>>;

/** Outcome per fact value. Unlisted values allow. */
export type Rules = Record<string, Record<string, Outcome>>;
export const DEFAULT_RULES: Rules = {
  requested: { false: 'ask' },
  deletes: { local_no_copy: 'ask', remote: 'deny' },
  ships: { live_reversible: 'ask', public_permanent: 'deny' },
  changes_system: { true: 'ask' },
  rewrites_history: { true: 'ask' },
  uploads_data: { true: 'ask' },
  exposes_secret: { true: 'deny' },
};

export type Thresholds = {
  /** Summed probability of an option and the stricter ones at which it counts; for nouls, true at or above. */
  hitMin: number;
  /** Probability of `none` needed to say nothing happened; for nouls, false at or below 1 - this. */
  noneMin: number;
  /** `requested` is true at or above this. */
  requestedMin: number;
  /** `requested` is false at or below this; strict, since Jev calls about 13% of real commands unasked at 0.5 and 3% at 0.25. */
  unrequestedMax: number;
};
export const DEFAULT_THRESHOLDS: Thresholds = { hitMin: 0.5, noneMin: 0.6, requestedMin: 0.6, unrequestedMax: 0.25 };

// ---------- questions ----------

const BASH_CONTEXT =
  '`command` is a shell command the coding assistant is about to run in `cwd`. `repo_root` is the git repository it works in, `remotes` is `git remote -v`, `git_status` is `git status --porcelain` (absent when not gathered, empty when clean), `current_branch` is the checked-out branch and `branch_pushed` whether it exists on a remote, `home` is the user\'s home directory, `known_hosts` are hosts the user declared as theirs, `recent` holds the latest conversation turns with their `role`. Judge the command as written; do not assume flags or paths it does not contain.';

const FILE_CONTEXT =
  '`command` describes a file tool the coding assistant is about to use: `tool` writes `path`, which lies outside the project (`repo_root`, or `cwd` when there is no repository) and outside the session scratchpad. `exists` says whether `path` is already there, `content_head` is the start of what would be written, `home` is the user\'s home directory, `recent` holds the latest conversation turns with their `role`.';

const TEXT: Record<Fact, (ctx: string) => Question> = {
  deletes: (ctx) => ({
    type: 'choice',
    instructions:
      ctx +
      ' What the command deletes, truncates or wholesale overwrites, judged by whether a copy survives anywhere. Includes `rm`, `mv`/`cp` over a target, `>` redirects, `git reset --hard`/`checkout --`/`restore`/`clean`/`stash drop`/`branch -D`, `find -delete`, `truncate`, `dd`, docker volume and prune commands, SQL `DROP`/`TRUNCATE`/`DELETE`, cloud and API deletes, and any of these over `ssh`. Git history on a remote (force pushes, deleting remote branches or tags) is not judged here. Edits that keep the rest of a file (`sed -i`, appending, patching, a script that rewrites part of a file), creating new files, and writing output, temp or scratchpad files are not deleting. When several things are removed, pick the option for the one least likely to be recovered.',
    criteria: {
      none: 'Nothing is lost that cannot be rebuilt: reads, edits, new files, output or temp files, or deleting only rebuildable things (build output, caches, dependency dirs, logs, docker images, scratchpad or /tmp files, tracked files with no uncommitted changes).',
      local_no_copy: 'Something on this machine with no other copy: discarding changes listed in `git_status` (`git checkout --`, `git restore`, `git reset --hard`, `git clean`, deleting or replacing such files), unpushed commits, ignored files holding data (`.env`, local databases, uploads), files outside `repo_root`, docker volumes, local database contents.',
      remote: 'Anything on another machine or service: remote databases, cloud storage and resources, files over `ssh`, records deleted through an API.',
    },
  }),
  ships: (ctx) => ({
    type: 'choice',
    instructions:
      ctx +
      ' What the command makes live or visible to people or systems outside this machine. Includes package publishes, deploys, merges on the remote (`gh pr merge`), releases, pushes to a protected branch (main, master, develop, release/*), running deploy or release scripts, migrations against a non-local database, and messages (Slack, email, webhooks). Not: `git add`/`commit`, local merges, pushing a feature branch, `gh pr create`, deleting data, editing deploy config without running it, local builds, dev servers, dry runs. When several apply, pick the option that is most public and least reversible.',
    criteria: {
      none: 'Nothing live changes: no shipping at all, or only previews, staging and draft releases.',
      live_reversible: 'The live product or main line changes but can be rolled back: production deploys, remote merges, pushes to a protected branch, `kubectl`/`helm`/`terraform apply` on production, remote migrations.',
      public_permanent: 'Cannot be taken back once seen: registry publishes (npm, cargo, PyPI, gem, public images), public releases or tags, messages, emails, webhooks, `gh repo create --public`.',
    },
  }),
  changes_system: (ctx) => ({
    type: 'noul',
    instructions:
      ctx +
      ' The command changes this machine beyond the current user, or uses elevated privileges: anything run with sudo/su/doas (even read-only), writing outside `home` (`/etc`, `/usr`, `/Library`, `/opt/homebrew`, `/Applications`), `brew`/`apt` installs or uninstalls, system services and daemons, `defaults write` to system domains, shutdown, reboot, disk and security tools (`diskutil`, `csrutil`, `spctl`). Not: `/tmp`, `/private/tmp` or a scratchpad, anything under `home` without elevated privileges (rc files, `~/.gitconfig`, user installs, user LaunchAgents and crontab), project files, deleting data, commands run on another host over `ssh`.',
    criteria: { true: 'Elevated privileges, or the system beyond the current user changes.', false: "Only the project or the current user's own files and settings change, or nothing changes." },
  }),
  rewrites_history: (ctx) => ({
    type: 'noul',
    instructions:
      ctx +
      ' The command rewrites or removes git history that already exists on a remote: force pushes (`--force`, `-f`, `--force-with-lease`, `+refspec`), `git push --delete` or `:ref`, `--mirror`, re-pushing a moved tag, `filter-branch`/`filter-repo` followed by a push. Use `remotes`, `current_branch` and `branch_pushed`. Not: force-pushing a branch that was never pushed, local amend/rebase/reset, ordinary push.',
    criteria: { true: 'History on a remote is replaced or removed.', false: 'Only local history changes, or pushes that only add commits.' },
  }),
  uploads_data: (ctx) => ({
    type: 'noul',
    instructions:
      ctx +
      ' The command sends local data (file contents, command output, environment variables, repo contents) to a host that is not known. Known hosts: localhost, 127.0.0.1, ::1, private LAN addresses, hosts in `remotes`, hosts in `known_hosts`, servers the user calls theirs in `recent`. Includes `curl`/`wget`/`http` with a body or upload (`-d`, `-F`, `-T`, POST/PUT carrying content), `scp`/`rsync`/`sftp` to a remote, piping into `nc`/`socat`, `/dev/tcp`, paste or transfer sites, cloud storage uploads, `gh gist create`, `git push` to a remote not in `remotes`, DNS lookups that embed data. Not: downloads (GET without a body), package installs, API reads, pushes to known remotes, writing a script without running it, publishing or deploying through a publish or deploy tool (`vercel`, `fly`, `npm publish`, `docker push`, `kubectl`, `terraform`), sending queries or commands to a database or service.',
    criteria: { true: 'Local data leaves for a host that is not known.', false: 'Nothing local leaves, or it only goes to known hosts.' },
  }),
  exposes_secret: (ctx) => ({
    type: 'noul',
    instructions:
      ctx +
      ' Running the command would print a secret value into its output, where the conversation transcript would capture it: reading `.env` files (not `.env.example`/`.sample`/`.template`), private keys (`~/.ssh/id_*`, `*.pem`, `*.p12`), credential files (`~/.aws/credentials`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube/config`, `~/.config/gh`, `~/.claude/settings*.json`), `env`/`printenv`/`set` dumps, `echo $TOKEN`, `gh auth token`, `git credential fill`, `security find-*-password -w`, `docker inspect`, `docker compose config`, `kubectl get secret -o`, `vault read`, `terraform output`, `grep -r` for password or token values, verbose modes that echo headers or commands (`curl -v` with an auth header, `set -x`). Not: printing or grepping variable names, source referencing `process.env.X`, using a secret without printing it (`curl -H "Authorization: $TOKEN"`, `source .env && …`), output redirected to a file and not printed.',
    criteria: { true: "A secret value would appear in the command's output.", false: 'No secret value is printed.' },
  }),
  requested: (ctx) => ({
    type: 'noul',
    instructions:
      ctx +
      ' Judged against `recent`: the command is something the user asked for, agreed to, or would expect as a natural step toward what they asked. Only `user` turns are requests. An `assistant` turn is a proposal: it counts as asked only when the user\'s next turn agrees ("yes", "go ahead", a number picking an option). Natural steps: reading, searching, running the project\'s tests, linters, formatters, type checks or build, installing the project\'s declared dependencies, creating or editing files the work needs, `git add`, a dev server the task needs for verification. Not natural: committing or pushing when not asked, working in another repository, installing tools or changing machine config not requested, deploying, deleting or rewriting unrelated files, doing the user\'s manual step for them. When `recent` is absent, answer from the command alone and lean true.',
    criteria: { true: 'Asked for, agreed to, or a natural step.', false: 'Clearly outside what the user asked for.' },
  }),
};

function build(ctx: string, facts: readonly Fact[]): Questions {
  const q: Questions = {};
  for (const f of facts) q[f] = TEXT[f](ctx);
  return q;
}
export const BASH_QUESTIONS: Questions = build(BASH_CONTEXT, BASH_FACTS);
export const FILE_QUESTIONS: Questions = build(FILE_CONTEXT, FILE_FACTS);

// ---------- answers to facts ----------

function isChoice(f: Fact): f is keyof typeof CHOICE_FACTS {
  return f in CHOICE_FACTS;
}

/** Turns Jev's answers into facts. A choice counts an option once it and the stricter ones reach `hitMin`. */
export function resolveFacts(res: JevResponse, facts: readonly Fact[], t: Thresholds = DEFAULT_THRESHOLDS): Facts {
  const out: Facts = {};
  for (const f of facts) {
    const a = res.answers[f];
    if (isChoice(f)) {
      if (!a || a.type !== 'choice') throw new Error(`Jev: missing choice answer "${f}"`);
      let v: Value = 'unsure';
      let sum = 0;
      for (const o of CHOICE_FACTS[f]) {
        sum += a.probabilities[o] ?? 0;
        if (sum >= t.hitMin) {
          v = o;
          break;
        }
      }
      if (v === 'unsure' && (a.probabilities.none ?? 0) >= t.noneMin) v = 'none';
      out[f] = v;
    } else {
      if (!a || a.type !== 'noul' || !Number.isFinite(a.noul)) throw new Error(`Jev: missing noul answer "${f}"`);
      const [yes, no] = f === 'requested' ? [t.requestedMin, t.unrequestedMax] : [t.hitMin, 1 - t.noneMin];
      out[f] = a.noul >= yes ? 'true' : a.noul <= no ? 'false' : 'unsure';
    }
  }
  return out;
}

/** Raw numbers for the log: a noul's probability, a choice's option probabilities. */
export function rawScores(res: JevResponse, facts: readonly Fact[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of facts) {
    const a = res.answers[f];
    if (a?.type === 'noul') out[f] = a.noul;
    else if (a?.type === 'choice') for (const [o, p] of Object.entries(a.probabilities)) if (o !== 'none') out[`${f}.${o}`] = p;
  }
  return out;
}

// ---------- facts to outcome ----------

/** `flags`: what the reason names, `not requested` included; empty when nothing was flagged. */
export type Decision = { action: Outcome; reason: string; hits: string[]; flags: string[]; facts: Facts };

/**
 * The strictest outcome among the facts, an unsure fact counting as `unsure`.
 * Not requested asks on its own and turns a flagged ask into a deny; an unsure
 * `requested` counts for nothing, since Jev is unsure about many ordinary commands.
 */
export function decideFacts(facts: Facts, rules: Rules = DEFAULT_RULES, unsure: Outcome = 'ask'): Decision {
  let action: Outcome = 'allow';
  let definite: Outcome = 'allow';
  const hits: string[] = [];
  for (const [f, v] of Object.entries(facts) as [Fact, Value][]) {
    if (f === 'requested') continue;
    const o = v === 'unsure' ? unsure : rules[f]?.[v];
    if (!o || o === 'allow') continue;
    hits.push(`${f}${v === 'true' ? '' : ` ${v}`}`);
    if (RANK[o] > RANK[action]) action = o;
    if (v !== 'unsure' && RANK[o] > RANK[definite]) definite = o;
  }
  const notAsked = facts.requested === 'false';
  if (notAsked) {
    // an unsure fact stays an ask: only a flagged fact the user did not ask for is refused
    if (definite === 'ask') action = 'deny';
    const o = rules.requested?.false;
    if (o && RANK[o] > RANK[action]) action = o;
  }
  const flags = [...hits, ...(notAsked ? ['not requested'] : [])];
  const detail = flags.join(', ');
  const reason = action === 'allow' ? 'jevgate: nothing flagged' : `jevgate: ${action === 'deny' ? 'denied' : 'asking'} · ${detail}`;
  return { action, reason, hits, flags, facts };
}

/** Rules with the overrides of a rules file on top: `{ "deletes": { "local_no_copy": "deny" }, "modes": { "auto": { … } } }`. */
export function mergeRules(base: Rules, file: unknown, mode: string | undefined): Rules {
  const out: Rules = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { ...v }]));
  const apply = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    for (const [f, vals] of Object.entries(o as Record<string, unknown>)) {
      if (f === 'modes' || !vals || typeof vals !== 'object') continue;
      for (const [v, oc] of Object.entries(vals as Record<string, unknown>)) {
        if (oc === 'allow' || oc === 'ask' || oc === 'deny') (out[f] ??= {})[v] = oc;
      }
    }
  };
  apply(file);
  const modes = (file as { modes?: Record<string, unknown> } | undefined)?.modes;
  if (mode && modes && typeof modes === 'object') apply(modes[mode]);
  return out;
}
