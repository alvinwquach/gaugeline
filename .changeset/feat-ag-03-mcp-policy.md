---
"gaugeline-mcp": minor
---

Every tool call is now checked before it runs: `--allow-tool`, `--calls-per-minute` (default 120) and `--cost-ceiling-micros` set the policy, `GAUGELINE_AGENTS_OFF` stops every call, and each refusal is one line on stderr. With no new flags all six tools work as before.
