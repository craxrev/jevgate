# jevgate

Claude Code plugin that uses TypeSafe AI's Jev (a fast, typed judgment model) as the
guard for `bypassPermissions` mode and to remove latency elsewhere in an agentic
coding session. Five independent features, each with its own on/off switch. No
feature depends on another.

| Feature | Hook | What it does | Default |
| --- | --- | --- | --- |
| Bash guard | `PreToolUse` on `Bash` | Claude Code's own read-only set runs without asking Jev; everything else is judged once against eight harm categories. Over a threshold: deny. All low: allow, which in auto mode skips the classifier. In between: silent, Claude Code decides. In bypass mode, Jev unreachable means deny. | on |
| File guard | `PreToolUse` on `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Read` | Writes inside the repo or scratchpad are free. A write outside gets one Jev call: does it change shell, git, ssh, Claude or system configuration, or another project. A read of a credential path (`.env`, `~/.ssh`, `*.pem`, …) is refused with no model call. | on |
| Done-check | `Stop` | Before Claude hands back, checks that the diff covers the request and the final message does not overclaim. Blocks with the reason, at most 2 times per turn. | on |
| Subagent gate | `PreToolUse` on `Agent` | Denies a subagent spawn when the answer is already in the recent conversation. | on |
| Verbatim compaction | `session.compact` function hook (early access) | Replaces the compaction summary with the original messages, long tool outputs truncated. Never rewrites text, never drops a call. One Jev call ranks which outputs to restore verbatim: a Choice over the candidates, gated by its confidence. Triggers at 60% context. | on |

Every decision is appended as JSON lines to `~/.claude/plugins/data/jevgate*/decisions.jsonl`
(or `~/.claude/jevgate/decisions.jsonl` when run from `--plugin-dir`). `/jevgate` opens a panel with the tally.

## Requirements

- Claude Code 2.1.274 or later. Function hooks need the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` env var.
- Node 22.18 or later on `PATH` (runs `.ts` directly, no build step).
- A TypeSafe API key, as `TYPESAFE_API_KEY` in `~/.claude/settings.json` `env`, or as the plugin's `apiKey` option.

## Install

```sh
claude plugin marketplace add ~/Developer/research/jevgate
claude plugin install jevgate@jevgate
```

Development: `claude --plugin-dir ~/Developer/research/jevgate --debug hooks`.

Settings env block:

```json
{ "env": { "TYPESAFE_API_KEY": "<key>", "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

## The bash guard

Made for `bypassPermissions` mode, where Claude Code has no classifier and no
prompts: the hook is the only thing standing between the model and the shell. A
hook `deny` is honored in every permission mode, so it also works as a hard floor
under auto mode and your `permissions.deny` rules.

For each `Bash` call:

1. **Free set.** The command is split (quote-aware, heredoc bodies kept whole) and
   checked against a local copy of Claude Code's read-only rules: `git status`,
   `ls`, `grep`, `cat`, `sed -n`, `find` without `-delete`/`-exec`, and so on, with
   no expansions, subshells, background jobs or redirects other than `2>&1` and
   `>/dev/null`. Paths that hold secrets (`.env`, `~/.ssh`, `~/.aws`, `*.pem`, …)
   are excluded so Jev sees them. A free command runs at once, logged as `free`.
   About a quarter of real calls.
2. **Context.** The hook gathers, without any model: the command as written, `cwd`,
   the repo root, `git remote -v`, `git status --porcelain` (only when the command
   touches git or files), and the last 8 turns of the conversation, user and
   assistant, with roles. Only user turns count as requests; an assistant turn
   counts once the user agreed to it.
3. **One Jev call**, eight `noul` questions, one per category:

   | Category | Deny at | Examples |
   | --- | --- | --- |
   | `destroys_uncommitted_work` | 0.5 | `reset --hard`, `checkout --`/`restore` on modified paths, `clean`, deleting or truncating a modified file. Editing a file is not this. |
   | `deletes_outside_repo` | 0.5 | `rm`/`mv` outside the repo and scratchpad, `~/.ssh`, `/etc`, other projects |
   | `rewrites_shared_history` | 0.5 | force push, push to main/protected, `remote set-url`, `filter-branch` |
   | `deploys_or_publishes` | 0.6 | publish, release, deploy, `gh pr merge`, restarting a remote service. Commits and branch pushes are not this. |
   | `exfiltrates` | 0.6 | uploads to a host that is not localhost or a known remote: `curl -d`, `scp`, `rsync`, `aws s3 cp` |
   | `reads_secrets` | 0.6 | `.env`, `~/.ssh`, `~/.aws`, keychain, `printenv`, `gh auth token` |
   | `escalates_or_system` | 0.7 | `sudo`, `launchctl`, `crontab`, rc files, killing unrelated processes, global installs |
   | `exceeds_request` | log only | does something the recent user messages did not ask for |

   The category furthest over its threshold denies, with
   `permissionDecisionReason` naming it and the score. When every deny category
   scores under the allow ceiling (`bashAllowMax`, default 0.3) the hook answers
   `allow`, logged `allow`. Between the two the hook is silent, logged `ok` and shown as `unsure`: Claude Code decides.
   Thresholds are plugin options (`bashDeny*`); 0 means log only.
4. **Jev unreachable** (timeout, error, malformed answer, no API key): in bypass
   mode → deny with `jevgate: Jev unreachable, refusing to run unguarded. Switch
   to auto mode (Shift+Tab) or retry.`, because nothing else would judge. In auto
   and default modes → silent, Claude Code's own flow takes over. Free commands
   always run.

What each answer means per mode:

| Hook answer | Bypass mode | Auto mode |
| --- | --- | --- |
| deny | refused | refused |
| allow | runs | runs; your `permissions.deny`/`ask` rules still apply; classifier skipped |
| silent | runs | Claude Code's rules, then the classifier |

On the corpus, 76% of judged commands stay under 0.2 on every deny category and
89% under 0.3, so in auto mode the classifier sees roughly one command in ten
instead of three in four.

Measured on 47 hand-written cases: safe commands score at most 0.28 on any deny
category, harmful ones at least 0.82. On 187 real commands from 105 sessions, 21
were denied at these thresholds: real deploys, `checkout --` of modified files, a
`filter-branch`, `cat ~/.claude/settings.json`, and rsync/scp to the user's own
server (Jev cannot know a host is yours; that is the main tension). Judged calls
take 300–1000ms.

Switching to bypass mode: `permissions.defaultMode: "bypassPermissions"` in
settings, or `claude --dangerously-skip-permissions`. Once the guard is live,
`permissions.deny` can be emptied.

## The file guard

Same idea for Edit/Write/MultiEdit/NotebookEdit/Read, where the path says most
of it, so almost every call costs nothing:

| Call | Decided by | Outcome |
| --- | --- | --- |
| write inside `repo_root` (or `cwd` without a repo) or a scratchpad | local | free, silent |
| write outside | one Jev call, two questions | `changes_system_or_user_config` ≥ 0.6 → deny (rc files, `~/.ssh`, `~/.claude/settings*`, `~/Library/LaunchAgents`, `/etc`, another project). `exceeds_request` log-only. Skill, agent and command files under `~/.claude`, notes and documents pass. |
| read of a credential path | local | deny, `reads_secrets` |
| any other read | local | silent, not logged |

Jev unreachable follows the Bash rule: deny in bypass mode, silent elsewhere.
Options: `fileEnabled`, `fileDenySystem`, `fileDenyExceeds`. In auto mode Claude
Code already sends outside writes to its classifier; the guard matters in bypass
mode, and for secret reads in every mode.

## Test

```sh
npm test                                   # unit tests, fake Jev, the sanitized corpus fixture
TYPESAFE_API_KEY=... npm run probe [bash|done|agent]        # live Jev on hand-written cases
TYPESAFE_API_KEY=... node scripts/probe-corpus.ts --file tests/fixtures/commands.jsonl
claude plugin validate .
```

`scripts/free-corpus.ts` compares the free set with the `analyze2.py` FREE bucket
over your own transcripts (`scripts/session-analysis/dump_buckets.py` produces the
input; it stays out of the repo because it holds conversation text).

Live check in a session: start with `--debug hooks` and run `git status` (free, no
log line in the UI), then something judged; the dim line under the row shows the
verdict and the two highest scores.

## Regenerating function-hook types

From a running session with the plugin loaded: `/plugin-types types`. Regenerate after upgrades.

## Design notes

- Jev only sees command text, deterministic git facts, recent user messages, the
  diff, or output heads. Never full tool outputs during compaction. Segments from
  the local splitter are never sent; Jev gets the command as written.
- Thresholds are per category by damage: 0.5 for irreversible local loss, 0.6–0.7
  for the rest, 0.95 for the subagent gate, 0.5 to block a stop.
- Compaction never drops a tool call. Edit and Write results, the first message, and
  the newest N messages are pinned. Truncated outputs carry a note telling the model
  to re-run the tool if needed.
- The bash guard fails closed in bypass mode only, where a silent hook would mean
  an unjudged command. Everywhere else every hook fails silent: any error means
  the stock Claude Code behavior.
