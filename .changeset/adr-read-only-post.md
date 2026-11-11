---
"gaugeline": minor
---

Read-only by construction now says exactly when Gaugeline may send a POST: only a documented read-only query to a platform's own API, from a per-adapter allowlist, never a write; those queries appear in Pages checked and in `--save-requests` (file schema 2).
