---
"gaugeline": minor
---

The GitHub Action can post one summary comment on the pull request (`comment: true`, off by default): this run's findings by level, a few titles, and how many are new compared with the baseline from main. It needs `pull-requests: write`, and a fork's read-only token never fails the check.
