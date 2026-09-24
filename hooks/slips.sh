#!/bin/sh
# Run by the module at a turn's end, on this session's pending file (answer.sh
# notes every call it let through as free). Prints `<tool_use_id><TAB><tool>`
# for each that Claude Code's classifier judged anyway: Claude Code marks such a
# call's result `"classifierBoundary":true` in the transcript. A result not
# written yet stays pending, for five turns at most.
#   slips.sh <pending file>
f=$1
[ -f "$f" ] || exit 0
work="$f.$$"
mv "$f" "$work" 2>/dev/null || exit 0
results="$work.results" seen=
while IFS='	' read -r id t tool n; do
  # the transcript's result records, read once per transcript
  if [ "$t" != "$seen" ]; then
    tail -c 4000000 "$t" 2>/dev/null | grep -F '"toolUseResult"' > "$results"
    seen=$t
  fi
  line=$(grep -F "\"tool_use_id\":\"$id\"" "$results")
  if [ -z "$line" ]; then
    n=$((n + 1))
    [ "$n" -lt 5 ] && printf '%s\t%s\t%s\t%s\n' "$id" "$t" "$tool" "$n" >> "$f"
  elif printf '%s' "$line" | grep -q -F '"classifierBoundary":true'; then
    printf '%s\t%s\n' "$id" "$tool"
  fi
done < "$work"
rm -f "$work" "$results"
