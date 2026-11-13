# Hosted: sign in and the shell

The hosted version of Gaugeline (in progress, not released) opens with an email link. There are no
passwords. This page covers the first part of "Sign in, and the dashboard": signing in, switching
organisation, and the page every signed-in person lands on. The dashboard itself is on [its own page](/hosted/dashboard); [what happened last night](/hosted/last-night) is another.

## An example: two agencies, one login

Northgate Studio looks after The Tidewater Bar and Juniper Pop-up Kitchen. Maya owns Northgate. Another
agency, Brightfield Web, looks after Maple Street Physio, and Sam works for both agencies. The bar's
manager has a client login.

| Who                          | Role          | After signing in                                                               |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------ |
| Maya                         | Owner         | Northgate's two sites                                                          |
| Sam (two agencies)           | Member, Admin | Both agencies, an organisation switch in the header; one is shown at a time    |
| The bar's manager            | Client viewer | The Tidewater Bar only, no switch and nothing to manage                        |
| Someone with no organisation | none          | A page that says they are not a member of any organisation yet, and a sign-out |

This is the stand-in server, run against the seeded test database (see "Running it locally" below), as
Maya:

```text
$ curl -si http://127.0.0.1:3101/ | head -4
HTTP/1.1 303 See Other
cache-control: no-store
content-security-policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
location: /sign-in

$ curl -X POST -d 'email=maya@northgate.test' http://127.0.0.1:3101/sign-in
<h1>Check your email</h1>

[stand-in] sign-in link for maya@northgate.test: http://127.0.0.1:3101/sign-in/verify?token=<one-time token>
```

Opening the link shows one button, "Sign in", and the button's POST signs in, so a mail scanner that opens
the link does not use it up. After that, the home page is the organisation's name, your role and the table of its sites (see
[the dashboard](/hosted/dashboard)); it shows only what the database lets Maya read:

```html
<main id="main">
  <h1>Northgate Studio</h1>
  <p class="muted">You are signed in as Owner.</p>
  <table class="sites">
    <caption>
      Sites, worst first
    </caption>
    <thead>
      <tr>
        <th scope="col">Site</th>
        <th scope="col" class="num">Fix this first</th>
        <th scope="col" class="num">Fix soon</th>
        <th scope="col">Since the run before</th>
        <th scope="col">Last checked</th>
        <th scope="col">New since then</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th scope="row">
          Juniper Pop-up Kitchen<br /><span class="muted">https://juniper-popup.test</span>
        </th>
        <td class="num">-</td>
        <td class="num">-</td>
        <td><span class="trend trend-unchecked">Not checked yet</span></td>
        <td>-</td>
        <td></td>
      </tr>
      <tr>
        <th scope="row">
          The Tidewater Bar<br /><span class="muted">https://tidewater-bar.test</span>
        </th>
        <td class="num">-</td>
        <td class="num">-</td>
        <td><span class="trend trend-unchecked">Not checked yet</span></td>
        <td>-</td>
        <td></td>
      </tr>
    </tbody>
  </table>
</main>
```

Nothing of Brightfield's appears. The bar's manager, signed in the same way, sees The Tidewater Bar and
nothing else.

## The link

- It is sent to the address you type. The page answers the same way whether or not the address has an
  account, so the form cannot be used to find out who has one.
- It works once and expires after 15 minutes. An expired or used link says so and offers a new one.
  Asking for a new link ends the older one, and expired links are dropped, so links do not pile up.
- An address with no account does the same work as one with an account, so the form's answer does not
  tell them apart. (The stand-in does not equalise the time to deliver the mail; the real provider
  rate-limits and has its own mail path.)
- Where you were going is kept in a cookie in the browser that asked, so a link opened in another
  browser does not inherit it. Only a path on this app is followed. A value is refused (and you land on
  the home page) if it does not start with exactly one `/`, contains any space, control, invisible or
  separator character (a browser strips a tab or newline, so `/<tab>/evil.test` would leave the site) or a
  backslash, or does not parse as a path on this app. `//evil.test`, `https://...`, `/\evil.test`,
  `/%09/...` (once decoded) and `javascript:` all go to the home page.
- The session is a cookie, `HttpOnly`, `SameSite=Lax`, and on https `Secure` with the `__Host-` prefix.
  Every action that changes something (sign out, switch organisation) must come from this app's own
  page: the `Origin` (or `Referer`) is checked as well. On https every response also carries
  `Strict-Transport-Security`.
- Signing out ends the session on the server, not just in your browser: the session's id is put on a
  revocation list (kept until the token would have expired anyway), so a copy of the cookie stops working
  at once.
- The token is checked strictly: `alg` HS256 and `typ` JWT only, one canonical spelling of the signature,
  at most 8 KB, issuer, audience and role as expected, `iat` and `nbf` not in the future (60 seconds of
  clock skew), and a lifetime of at most 30 days whatever it claims. The user id is compared in lower case.

## Who sees what

The database decides (the policies in [data model and tenancy](/hosted/data-model)); the pages do not
rely on it alone.

| Role          | The page shows                                           |
| ------------- | -------------------------------------------------------- |
| Owner, admin  | their organisations, every site of the one selected      |
| Member        | the same                                                 |
| Client viewer | their one site; no switch, no "add" or "invite" anywhere |

A client viewer's site list is narrowed to their one site in the query as well as by the policy. The
organisation in the switch is a preference stored in a cookie: it is used only if the database says you
are a member of it, so a forged cookie changes nothing.

## What the page can and cannot hold

- The pages are server-rendered HTML with no script at all. The Content-Security-Policy is
  `default-src 'none'` plus this app's own stylesheet, forms to itself, and no framing.
- Text a checked site chose (a finding's title or evidence line) is shown as text: cleaned with the same
  helper the CLI uses before anything leaves the engine (`sanitise` in `@gaugeline/core`: hidden tag
  characters and bidirectional controls removed, control characters shown, capped), then escaped. It is
  never markup.
- Nothing secret is in a page. The signing secret, the database address and the session token never
  appear in a response (a test checks every page for all three).

## The database login

The app connects with its own login role (`GAUGELINE_WEB_DATABASE_URL`), never the table owner and never
a superuser, because both skip row-level security. At start-up it asks `connectionSkipsRls()` once and
refuses to serve if the answer is yes. It also refuses a login that is, or can become, `service_role` or a
role that bypasses row-level security: that login is the runs API's (`GAUGELINE_DATABASE_URL`), a separate
role, because the web app reads as the signed-in person only. Every read a signed-in person causes then runs in one transaction that starts with
`set local role authenticated` and sets `request.jwt.claims` to that person's verified claims, and checks
that the database sees the same person (`auth.uid()`). The app never writes runs or findings (the runs API
does, as the server) and never chooses an id, `decided_at` or `recorded_at`.

## Running it locally

```bash
GAUGELINE_WEB_DATABASE_URL=postgres://app-login:...@127.0.0.1:5432/gaugeline \
GAUGELINE_AUTH=stand-in GAUGELINE_STANDIN_SECRET=<32+ characters> \
GAUGELINE_STANDIN_USERS="maya@northgate.test=<user id>" \
pnpm --filter @gaugeline/hosted dev
```

| Variable                     | What it is                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `GAUGELINE_WEB_DATABASE_URL` | the app's own login (a member of `authenticated` only), not the owner's address |
| `GAUGELINE_APP_URL`          | the public address; `https://` makes cookies `Secure`                           |
| `GAUGELINE_AUTH`             | `supabase` or `stand-in`. Anything else is "not configured": every page is 503  |
| `GAUGELINE_STANDIN_*`        | the stand-in's signing secret and its list of addresses and user ids            |
| `SUPABASE_*`                 | Supabase Auth's settings; see "Signing in with Supabase Auth" below             |

The stand-in has no mail server: the link is printed in the terminal that runs it. It runs only when
`NODE_ENV` is exactly `development` or `test` (unset, `Production`, `staging` and every other value are
refused), `GAUGELINE_AUTH=stand-in` must be set as well, its secret must be 32 or more characters with at
least 16 different ones, and the development server (`pnpm --filter @gaugeline/hosted dev`) treats an unset
`NODE_ENV` as `development`. The browser test (`pnpm hosted:e2e`) and the database tests
(`pnpm exec vitest run apps/hosted`) need a Postgres server you can create databases on; see
[data model and tenancy](/hosted/data-model).

## The stand-in and Supabase Auth

Sign-in sits behind an interface, `AuthProvider` (`requestLink`, `exchangeLink`, `verify`, `revoke`). The
stand-in signs an HS256 token with the claims Supabase Auth puts in an access token: `sub`, `aud`
(`authenticated`), `role` (`authenticated`), `email`, `session_id`, `aal`, `is_anonymous`, `iat` and
`exp`. That is what the policies read through `auth.uid()`, so they run the same with either provider.

## Signing in with Supabase Auth

With `GAUGELINE_AUTH=supabase` the same pages talk to Supabase Auth instead. Nothing a person sees
changes: the same form, the same "Check your email" answer, the same "Sign in" button behind the link.

| Variable              | What it is                                                                              |
| --------------------- | --------------------------------------------------------------------------------------- |
| `SUPABASE_URL`        | the project's address, `https://` and nothing after the host                            |
| `SUPABASE_ANON_KEY`   | the anon (publishable) key. A service-role or secret key is refused at start-up         |
| `SUPABASE_JWT_SECRET` | the project's JWT secret, if it signs tokens with a shared secret (HS256)               |
| `SUPABASE_JWKS`       | the project's public signing keys (ES256 or RS256), the JSON its key-set address serves |

Set `SUPABASE_JWT_SECRET`, `SUPABASE_JWKS` or both. The server refuses to start when a value is missing or
weak: an address that is not `https` (plain `http` only to `127.0.0.1` in development or test, for the
local Supabase stack), has a user, path or query; no anon key; a key that is really a service-role or
secret key; a JWT secret under 32 characters; a key set holding a private key. The error names the
variable, never its value. Sign-in never reads `SUPABASE_SERVICE_ROLE_KEY` (a test checks it).

What each step does:

| Step            | Request to Supabase Auth                                    | Notes                                                                                    |
| --------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Ask for a link  | `POST /auth/v1/otp` with `{email, create_user: false}`      | Only people already invited get a link. The page answers after the same fixed time       |
| Open the link   | nothing (the page shows the "Sign in" button)               | A mail scanner opening the link does not use it up                                       |
| Press "Sign in" | `POST /auth/v1/verify` with `{type: "email", token_hash}`   | Any refusal says the link is no longer valid                                             |
| Every page      | none: the token is checked here                             | HS256 with the secret, or ES256/RS256 with the key of the token's `kid` only             |
| Sign out        | `POST /auth/v1/logout?scope=local` with the session's token | The session is also put on the local revocation list, so it ends here even if that fails |

Every request carries the anon key as `apikey`, follows no redirect, gives up after 10 seconds and reads at
most 64 KB of answer. What Supabase answers is never shown in a page or written to a log: a failure logs
one line with the step and the status, such as `[auth] supabase otp failed: 422`.

A token is accepted only if its issuer is exactly `SUPABASE_URL` + `/auth/v1`, its audience and role are
`authenticated` (never `anon` or `service_role`), it has a `session_id`, is not an anonymous user's, and
passes the same time and shape rules as the stand-in's. The session lasts as long as Supabase's access
token (an hour by default) and then asks for a new link.

Supabase's magic link template has to send people to this app's verify page with the link's token hash.
In Auth, Email Templates, Magic Link, the link is:

```html
<a href="{{ .SiteURL }}/sign-in/verify?token={{ .TokenHash }}">Sign in</a>
```

The adapter's tests run against a recording stand-in for Supabase Auth and check each request against
Supabase's published API:

```text
$ pnpm exec vitest run apps/hosted/app/__tests__/supabase-auth.test.ts

 Test Files  1 passed (1)
      Tests  27 passed (27)
```

What the owner creates (none of this exists yet; nothing in this repository creates it):

1. A Supabase project on a paid plan, and its Postgres.
2. Auth: the email provider on with magic links, sign-ups off (people are invited into an organisation), a
   15-minute link expiry, the Magic Link template above, and the app's address as the Site URL with
   `/sign-in/verify` on the redirect allow-list.
3. Mail: custom SMTP so links come from the product's own domain (a separate task).
4. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_JWKS` (or `SUPABASE_JWT_SECRET`) as server secrets
   of the app, and `GAUGELINE_AUTH=supabase`.
5. The app's login role (NOINHERIT, a member of `authenticated`), and its address as
   `GAUGELINE_WEB_DATABASE_URL`.

## Not here yet

- Refresh tokens: a session lasts as long as its access token (8 hours with the stand-in, Supabase's
  setting with Supabase) and then asks for a new link.
- Durable sign-out: the local revocation list is in memory, so it is lost on a restart and not shared by
  two server processes. With Supabase, the session is also ended at Supabase; with the stand-in, its
  unused links are in memory too.
- Rate limits on asking for a link beyond Supabase's own.
- Sign-in with Google or GitHub, and two-factor sign-in.
- Creating an organisation and inviting people (agencies, X66).
- Adding a site and verifying that you own it, and the nightly time. The hosted service cannot check a
  site until ownership is verified, so adding sites has its own change.
