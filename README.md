# jevgate

Claude Code plugin that uses TypeSafe AI's Jev (a fast, typed judgment model) to
remove latency from an agentic coding session. Four independent features, each
with its own on/off switch. No feature depends on another.

| Feature | Hook | What it does | Default |
| --- | --- | --- | --- |
| Bash pre-approval | `PreToolUse` on `Bash` | Pre-approves read-only and test/build/lint commands so the permission step resolves locally. Never denies. | on |
| Done-check | `Stop` | Before Claude hands back, checks that the diff covers the request and the final message does not overclaim. Blocks with the reason, at most 2 times per turn. | on |
| Subagent gate | `PreToolUse` on `Agent` | Denies a subagent spawn when the answer is already in the recent conversation. | on |
| Verbatim compaction | `session.compact` function hook (early access) | Replaces the compaction summary with the original messages, long tool outputs truncated. Never rewrites text, never drops a call. Jev ranks which outputs to restore verbatim. Triggers at 60% context. | on |

Every decision is appended as JSON lines to `~/.claude/plugins/data/jevgate*/decisions.jsonl`
(or `~/.claude/jevgate/decisions.jsonl` when run from `--plugin-dir`). Tune thresholds from that file.

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

## How the bash gate fits the permission flow

1. This hook runs first and may answer `allow`.
2. Your `permissions.deny` and `permissions.ask` rules are evaluated regardless, and win.
3. If no rule fired and the hook allowed, the call proceeds without further review.
4. Otherwise the call continues through the normal permission flow.

Commands matching the passthrough list in `src/bash-policy.ts` (git push, rm, curl,
sudo, package installs, redirects, credentials, and so on) are never sent to Jev and
always continue through the normal flow.

## Test

```sh
npm test                       # unit tests, fake Jev
TYPESAFE_API_KEY=... npm run probe [bash|done|agent]   # live Jev on hand-written cases
claude plugin validate .
```

Live check in a session: start with `--debug hooks`, run `git status`, and compare
the delay before execution with the plugin on and off. The debug log shows the hook's
decision; a `pass` means the normal flow ran.

## Regenerating function-hook types

From a running session with the plugin loaded: `/plugin-types types`. Regenerate after upgrades.

## Design notes

- Jev only sees command text, a short description, the diff, recent turns, or output
  heads. Never full tool outputs during compaction.
- Thresholds are per action by risk: 0.95 to allow or deny, 0.5 to block a stop.
- Compaction never drops a tool call. Edit and Write results, the first message, and
  the newest N messages are pinned. Truncated outputs carry a note telling the model
  to re-run the tool if needed.
- All hooks fail silent: any error means the stock Claude Code behavior.
