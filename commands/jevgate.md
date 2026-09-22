---
description: Show the jevgate bash guard tally for this session and all-time
allowed-tools: Bash(node --no-warnings ${CLAUDE_PLUGIN_ROOT}/scripts/stats.ts*)
---

Run this and show its output verbatim in a code block, then stop:

```
node --no-warnings ${CLAUDE_PLUGIN_ROOT}/scripts/stats.ts
```

Counts: `free` commands ran without asking Jev (Claude Code's read-only set), `ok` were judged and ran, `denied` were refused with the category named, `unreachable` were refused because Jev did not answer.
