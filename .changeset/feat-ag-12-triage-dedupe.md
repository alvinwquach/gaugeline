---
"gaugeline": patch
---

The hosted triage agent no longer queues a second draft for a cause that already has a draft waiting for approval. It reads the site's waiting drafts first, with its own token, skips those causes and reports them as "already waiting"; if it cannot read them it drafts nothing that night.
