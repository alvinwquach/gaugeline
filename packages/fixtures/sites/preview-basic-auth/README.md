# preview-basic-auth

The `plan-built` pages behind HTTP basic auth (RFC 7617), for checking a protected preview (G17a).
Every path answers 401 with `WWW-Authenticate: Basic` unless the request carries
`Authorization: Basic` for the invented `harbour:glaze-and-fire`. Nothing here is a real account.

`/away` redirects to the same server as `elsewhere.test` (another origin; map it with the fetcher's
`hosts`), so a test can assert from the
request log that the second request carries no auth header.

`/members` answers 401 even with the preview's password: a members area inside a plan, which is
could-not-check for its row while the rest are checked.
