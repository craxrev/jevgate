#!/bin/sh
# SessionStart: jevgate lives in its function-hook module; with function hooks
# off nothing judges, so say so once instead of guarding nothing in silence.
cat > /dev/null
case $CLAUDE_CODE_ENABLE_FUNCTION_HOOKS in 1|true) exit 0;; esac
printf '%s' '{"systemMessage":"jevgate: function hooks are off (set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1), so nothing is guarded. In bypass mode every guarded call is refused."}'
