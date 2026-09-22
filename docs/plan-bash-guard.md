# Plan: turn the bash gate into a guard for bypass mode

Status: implemented 2026-09-22 (steps 1–6, version 0.2.0). Splitter in
`src/shell.ts`, free set in `src/free.ts`, categories in `src/bash-policy.ts`,
context in `src/bash-context.ts`. Final thresholds: 0.5 / 0.5 / 0.5 / 0.6 / 0.6 /
0.6 / 0.7 (system raised after a 0.67 false positive) / log-only. Step 7 is the
user's. See README for the measured results.

0.2.1: the hook also answers `allow` when every deny category is under
`bashAllowMax` (0.3), so auto mode skips its classifier; Jev unreachable denies
only in bypass mode (`permission_mode` from the hook input), silent elsewhere.

## Decision

The user will run Claude Code in `bypassPermissions` mode. There is no
classifier in that mode, so jevgate's Bash hook stops being a "fast-lane" that
competes with the classifier and becomes the guard itself: it denies harmful
commands, everything else runs. The user also intends to empty
`permissions.deny`, so Jev carries those judgments, scoped by context (inside
repo vs outside, uncommitted work present or not).

Why: measured on 105 real sessions (7,162 Bash calls), 76.5% reached the
classifier. The fast-lane could recover at most ~half of that and depends on a
hook-allow path that Claude Code has a gated flag to override
(`tengu_virtual_knuth`, currently off). A hook deny is honored in every mode.

Other features (done-check, subagent gate, compaction, UI) are unchanged.

## What changes

### `src/bash-policy.ts` (rewrite)
- Remove `NEVER_ASK` regex list and `neverAskReason`.
- Add a shell splitter: segments on `&&`, `||`, `;`, `|`, `|&`, `&`, newline,
  quote-aware; heredoc bodies kept whole (delimiter to terminator); `-c`/`-e`
  string bodies extracted; `$( )`, backticks, `${ }`, unquoted `$VAR`,
  subshells, brace expansion flagged; wrappers `sh -c`, `bash -c`, `env`,
  `time`, `timeout`, `nohup`, `xargs` noted; leading `VAR=val` prefixes split
  off. Output: `{ segments: [{ text, program, args, flags, label }], scripts:
  [{ lang, body }], syntax: string[] }`.
- Add the free set mirroring Claude Code 2.1.274 (extracted from the binary,
  offsets in the section below). `isFree(command)` = every segment free, no
  disqualifying syntax, redirects only `2>&1` / `>/dev/null` / `<`.
- Replace the three fast-lane questions with harm categories, one `noul`
  question each, per-category deny threshold and scope:
  | category | deny when | default threshold |
  | --- | --- | --- |
  | destroys_uncommitted_work | reset --hard / checkout -- / clean / rm on paths with uncommitted changes (git status provided) | 0.5 |
  | deletes_outside_repo | rm/rmdir/mv targets outside repo root and scratchpad, or critical paths | 0.5 |
  | rewrites_shared_history | force push, push to protected/shared branch, remote add/set-url, filter-branch | 0.5 |
  | deploys_or_publishes | deploy, publish, release, prod targets | 0.6 |
  | exfiltrates | sends data to a host that is not localhost or the repo's remotes | 0.6 |
  | reads_secrets | .env, ~/.ssh, ~/.aws, keychain, tokens | 0.6 |
  | escalates_or_system | sudo, launchctl, crontab, system config, kill of unrelated processes | 0.6 |
  | exceeds_request | does something the recent user messages did not ask for | log-only at first (no deny); probe scored 0.42 on a harmless multi-line lint+test |
- `decide()` returns `{ action: 'deny', category, reason }` or `{ action: 'ok' }`.

### `hooks/bash-gate.ts`
- Flow: parse → `isFree` → return silent (log `free`, not counted).
  Else gather state, built deterministically by the hook (no model involved):
  `command` (as written, not segmented; segments are for the local free check
  only), `cwd`, `repo_root` (`git rev-parse --show-toplevel`), `remotes`
  (`git remote -v`), `git_status` (`git status --porcelain`, only when a
  segment is git or deletes/moves files), `recent` (last 5 human messages from
  `transcript_path`). The eight questions are identical on every call. One
  Jev call. On any category over threshold, emit
  PreToolUse `deny` with `permissionDecisionReason` naming the category and
  score. Else silent. Log `ok` / `denied` with all scores.
- Fail-closed: any Jev error or timeout → deny with reason `jevgate: Jev unreachable, refusing to run unguarded. Switch to auto mode (Shift+Tab) or retry.` The user falls back to auto mode while Jev is down. Free commands still run. Log `unreachable`.
- Optional `bashMode` config: `guard` (default, deny) | `fastlane` (legacy
  allow behavior for auto-mode users). Keep `fastlane` minimal or drop it.

### `src/config.ts` / `.claude-plugin/plugin.json`
- Per-category thresholds as options (`bashDenyDestroy`, `bashDenyExfil`, …)
  or one `bashThresholds` JSON string. Prefer separate numeric options so they
  show in the config menu.

### UI (`src/ui-model.ts`, `hooks/compact.ts`)
- Outcomes: `free` (silent, not counted), `ok` (Jev judged, ran), `denied`.
- Footer: `jev ✓n` = ok, `⊘n` = denied (rename the subagent glyph to avoid
  clash, e.g. subagent `⊘` → `⇢`). Row line: `▸ jevgate ok · <top 2 scores> ·
  Nms` / `✗ jevgate denied · <category> 0.82`.
- `/jevgate` stats command (planned, not built): per-session and all-time
  counts of free / ok / denied, top denied categories, avg latency.

### Tests / probe
- Splitter unit tests (compound, heredoc, quotes, `$( )`, wrappers, env
  prefixes, multi-line).
- Free-set tests against the binary-extracted list.
- Decide tests with fake scores per category.
- Probe corpus: take real commands from
  `scratchpad/session-analysis/analyze2.py` output (the user's own sessions),
  run harm questions live, print a table, hand-label a few dozen to tune
  thresholds. Copy a sanitized corpus into `tests/fixtures/commands.txt`.

### Docs
- Update `README.md` and `docs/overview.html`: bash gate is a guard for bypass
  mode; permission flow section rewritten.

### User settings (manual, by the user)
- Switch to bypass: `permissions.defaultMode: "bypassPermissions"` or run
  `claude --dangerously-skip-permissions`.
- Empty `permissions.deny` once the guard is live; no backstop rules needed since the hook fails closed.

## Reference: Claude Code 2.1.274 read-only rules (from the binary)

Binary: `.../@anthropic-ai/claude-code/bin/claude.exe`, JS embedded as latin1
text ~168–205 MB offset. Grep with `grep -a -b -o`.

Core list `yit` @177557118: docker ps, docker images, cal, uptime, cat, head,
tail, wc, stat, strings, hexdump, od, nl, id, uname, free, df, du, locale,
groups, nproc, basename, dirname, realpath, cut, paste, tr, column, tac, rev,
fold, expand, unexpand, fmt, comm, cmp, numfmt, readlink, diff, true, false,
sleep, which, type, expr, seq, tsort, pr.

Special cases (`n8o`): echo always; ls always; cd with ≤1 operand; pwd,
whoami, alias with no args; exact argv: `claude -h`, `claude --help`,
`node -v`, `node --version`, `python --version`, `python3 --version`,
`ip addr`; printf with restricted format; `[[`, history, arch, ifconfig.

Glob fallback set `o8o` @177560866: ls cat head tail wc stat grep egrep fgrep
diff du df echo strings hexdump od nl cut column tr tac rev cmp basename
dirname realpath readlink sha256sum sha1sum md5sum cd.

Flag-gated table `fDn` @177542349 keys: xargs, git, file, sed, sort, man,
help, netstat, ps, base64, grep, egrep, fgrep, rg, sha256sum, sha1sum,
md5sum, tree, date, hostname, lsof, pgrep, tput, ss, fd, fdfind, pyright,
docker (logs/inspect), test. Rules: every flag must be in the command's
`safeFlags`; sort forbids `-o/--output`; sed forbids `-i/--in-place/-f` and
runs a sed-script safety check; find forbids `-delete -exec -execdir -ok
-okdir -fprint -fprint0 -fls -fprintf -files0-from`; xargs may only target
echo printf wc grep egrep fgrep head tail; any later arg containing `$`
rejects; brace expansion rejects; backticks reject unless a regex is given;
grep family rejects embedded newlines.

git read-only subcommands `ngt` @172746999: diff log show shortlog reflog
"stash list" ls-remote status blame ls-files "config --get" "remote show"
remote merge-base rev-parse rev-list describe cat-file for-each-ref grep
"stash show" "worktree list" tag branch. `git -c`, `--exec-path`,
`--config-env` reject. `ls-remote` rejects `-o/--server-option`.

Splitting (`Wf` @175565023, tree-sitter-bash): operators `&& || | ; & |&
\n`. Not read-only ("passthrough") when: subshell or compound statement;
trailing `&`; unquoted variable expansion; `$( )` / `${ }`; heredoc with an
unquoted delimiter. Wrapper stripping in the read-only path covers only
`command [-p]`, `builtin`, `noglob`; `sh -c`, `env`, `time`, `timeout`,
`nohup`, `sudo` are never read-only.

Redirects (`kDn`): `<`, `<<`, `<&`, `<<<` ignored; other redirects must target
`/dev/null` or be `>&` with a numeric fd; `/dev/tcp/*`, `/dev/udp/*` reject.

Env prefixes allowed (`Qle` @177576201): GOEXPERIMENT GOOS GOARCH CGO_ENABLED
GO111MODULE RUST_BACKTRACE RUST_LOG NODE_ENV PYTHONUNBUFFERED
PYTHONDONTWRITEBYTECODE PYTEST_DISABLE_PLUGIN_AUTOLOAD PYTEST_DEBUG
ANTHROPIC_API_KEY LANG LANGUAGE LC_ALL LC_CTYPE LC_TIME CHARSET TERM COLORTERM
NO_COLOR FORCE_COLOR TZ LS_COLORS LSCOLORS GREP_COLOR GREP_COLORS GCC_COLORS
TIME_STYLE BLOCK_SIZE BLOCKSIZE COLUMNS LINES CLICOLOR CLICOLOR_FORCE CI
DEBIAN_FRONTEND GIT_TERMINAL_PROMPT.

Compound combination (`p8o`): any deny wins; more than one `cd` → ask; `cd` +
`git` in one compound → ask; all allow → allow.

Not available locally: the classifier prompt and model (server-side). Only the
input builder `toAutoClassifierInput` exists in the binary; extracting it was
refused by the classifier in the planning session.

## Measured baseline (105 sessions, 7,162 Bash calls)

free 23.4% · scripts 39.0% · network/dangerous 17.8% · file writes 11.9% ·
local git 3.9% · installs 2.4% · shell-syntax-only 1.4%. Reaches classifier
today: 76.5%. Compound: 82.9% of calls. Scripts: python3 1262, python 294, uv
237, node 204, then user binaries (sketchybar, yue2, lyricfit).

## Probe result (2026-09-22, live Jev, scratchpad/guard-probe/probe.ts)

Safe cases (`npm test | tail`, multi-line lint+test, heredoc python rewriting
files inside the repo) scored under 0.42 on every category. An exfiltration
case (`.env` posted to an outside host) scored exfiltrates 0.97, reads_secrets
0.98. Soft signals: reads_secrets 0.38 on plain `npm test`, destroys 0.28 on
in-place file rewrites with a clean git status.

## Order of work

1. Splitter + free set + tests. Verify on the corpus that `isFree` matches
   the FREE bucket of `analyze2.py` (target: same 23.4%).
2. Harm questions + decide + config thresholds + tests.
3. Hook rewrite (state gathering, deny output, logging, fail-open).
4. Live probe on the corpus, hand-label, tune thresholds.
5. UI outcome rename, footer, row line. `/jevgate` command.
6. Docs. Bump version, marketplace update, plugin update, commit.
7. User switches to bypass mode and starts emptying `permissions.deny`.

## Open questions

- Whether to guard `Agent` spawns and `SendMessage` in bypass mode too, since
  auto mode's review of subagent reports is lost. Not in this iteration.
