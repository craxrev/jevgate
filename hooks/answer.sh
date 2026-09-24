#!/bin/sh
# PreToolUse for the guarded tools. The jevgate module judged this call in its
# tool.call hook, which runs first, and left ~/.claude/jevgate/run/verdicts/<tool_use_id>: a line per
# permission mode, `<mode><TAB><kind><TAB><reason as JSON>`, `*` for the rest.
# Answering here, not from the module, makes an ask Claude Code's own prompt.
# No verdict (the module is off or failed): refused where nothing else would
# judge (bypass, dontAsk), else left to Claude Code's own flow.
in=$(cat)
field() { case $in in *"\"$1\":\""*) v=${in#*\"$1\":\"}; printf '%s' "${v%%\"*}";; esac; }
id=$(field tool_use_id)
mode=$(field permission_mode)
case $mode in ''|bypassPermissions|dontAsk) closed=1;; *) closed=;; esac
answer() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":%s}}' "$1" "$2"; }
refuse() { [ -n "$closed" ] && answer deny "$1"; exit 0; }
# a free call is left to Claude Code, whose classifier should not see it: noted for
# hooks/slips.sh, which the module runs at the turn's end to log any that it did
noteFree() {
  s=$(field session_id) t=$(field transcript_path) tool=$(field tool_name)
  case $s in ''|*[!A-Za-z0-9_-]*) return;; esac
  [ -n "$t" ] || return
  p="$HOME/.claude/jevgate/run/pending"
  [ -d "$p" ] || mkdir -p "$p"
  printf '%s\t%s\t%s\t0\n' "$id" "$t" "$tool" >> "$p/$s"
}
case $id in ''|*[!A-Za-z0-9_-]*) refuse '"jevgate: no tool_use_id to find a verdict by, refusing to run unguarded."';; esac
f="$HOME/.claude/jevgate/run/verdicts/$id"
[ -f "$f" ] || refuse '"jevgate: the jevgate module did not judge this call (are function hooks on?), refusing to run unguarded."'
if [ -f "$f.match" ] && ! printf '%s' "$in" | grep -F -q -f "$f.match"; then
  rm -f "$f" "$f.match"
  refuse '"jevgate: the call changed after jevgate judged it, refusing to run unguarded."'
fi
kind= reason=
while IFS='	' read -r m k r; do
  if [ "$m" = "$mode" ]; then kind=$k reason=$r; break; fi
  [ "$m" = '*' ] && [ -z "$kind" ] && kind=$k reason=$r
done < "$f"
rm -f "$f" "$f.match"
case $kind in
  allow|ask|deny) answer "$kind" "$reason";;
  unreachable|nokey) [ -n "$closed" ] && answer deny "$reason";;
  blocked) [ -n "$closed" ] && answer ask "$reason";;
  free) noteFree;;
esac
exit 0
