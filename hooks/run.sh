#!/bin/sh
# Runs one gate script and keeps its stderr. A gate that dies before it can
# answer (Node failed to load it, a missing file, a crash at import) would
# otherwise exit 1, which Claude Code treats as a warning and runs the command
# unguarded. In "closed" mode such a death becomes exit 2, a block; in "open"
# mode it becomes exit 0, silent. Either way the trace goes to hook-errors.log.
#   run.sh closed|open <gate.ts>
mode="$1"; gate="$2"
log="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/jevgate}/hook-errors.log"
err="$(mktemp 2>/dev/null || echo "/tmp/jevgate-hook-$$.err")"
node --no-warnings "$gate" 2>"$err"
code=$?
if [ -s "$err" ]; then
  mkdir -p "$(dirname "$log")" 2>/dev/null
  { printf -- '--- %s %s exit %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$gate")" "$code"; cat "$err"; } >>"$log" 2>/dev/null
  cat "$err" >&2
fi
rm -f "$err"
if [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then
  if [ "$mode" = "closed" ]; then
    echo "jevgate: hook $(basename "$gate") crashed (exit $code), refusing to run unguarded. See $log" >&2
    exit 2
  fi
  exit 0
fi
exit "$code"
