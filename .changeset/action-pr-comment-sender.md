---
---

(internal) The one module that will send the Action's pull request comment: one POST to api.github.com with the workflow's own token, no retry, nothing reads the answer. Nothing calls it yet; ADR-0005 has its amendment.
