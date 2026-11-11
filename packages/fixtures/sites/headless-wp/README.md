# headless-wp

An invented restaurant (Saltmarsh Kitchen) on WordPress with a Faust.js front end, for the
headless WordPress checks (FW-09). Nothing here is a real business, address or deployment.

- The page embeds Apollo state with WordPress types: an unpublished post (`status: draft`), a
  user's `email` and `roles`, and an `apiToken` field: `headless-wp-private-fields`.
- `/graphql` answers a GET introspection query with its schema: `headless-wp-introspection-open`
  (probing: only with `--owner-consent`).
- The page links to a preview address (`/specials?p=14&preview=true&...`) that answers 200 with a
  draft and no login: `headless-wp-preview-open` (probing).
- The canonical is a WordPress preview link (`?p=12&preview=true`): `headless-wp-preview-canonical`.
