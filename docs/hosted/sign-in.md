# Hosted: sign in and the shell

The hosted version of Gaugeline (in progress, not released) opens with an email link. There are no
passwords. This page covers the first part of "Sign in, and the dashboard": signing in, switching
organisation, and the page every signed-in person lands on. The dashboard itself is on [its own page](/hosted/dashboard); "what happened last night" comes in the next
change.

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
the link does not use it up. After that, the home page shows what the database lets Maya read:

```html
<main id="main">
  <h1>Northgate Studio</h1>
  <p class="muted">You are signed in as Owner.</p>
  <h2>Sites</h2>
  <ul>
    <li>Juniper Pop-up Kitchen</li>
    <li>The Tidewater Bar</li>
  </ul>
</main>
```

Nothing of Brightfield's appears. The bar's manager, signed in the same way, sees The Tidewater Bar and
nothing else.

## The link

- It is sent to the address you type. The page answers the same way whether or not the address has an
  account, so the form cannot be used to find out who has one.
- It works once and expires after 15 minutes. An expired or used link says so and offers a new one.
- Where you were going is kept in a cookie in the browser that asked, so a link opened in another
  browser does not inherit it. Only a path on this app is followed; `//evil.test`, `https://...` and
  `/\evil.test` all go to the home page.
- The session is a cookie, `HttpOnly`, `SameSite=Lax`, and on https `Secure` with the `__Host-` prefix.
  Every action that changes something (sign out, switch organisation) must come from this app's own
  page: the `Origin` (or `Referer`) is checked as well.

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

The app connects with its own login role, never the table owner and never a superuser, because both skip
row-level security. At start-up it asks `connectionSkipsRls()` once and refuses to serve if the answer is
yes. Every read a signed-in person causes then runs in one transaction that starts with
`set local role authenticated` and sets `request.jwt.claims` to that person's verified claims, and checks
that the database sees the same person (`auth.uid()`). The app never writes runs or findings (the runs API
does, as the server) and never chooses an id, `decided_at` or `recorded_at`.

## Running it locally

```bash
GAUGELINE_DATABASE_URL=postgres://app-login:...@127.0.0.1:5432/gaugeline \
GAUGELINE_AUTH=stand-in GAUGELINE_STANDIN_SECRET=<32+ characters> \
GAUGELINE_STANDIN_USERS="maya@northgate.test=<user id>" \
pnpm --filter @gaugeline/hosted dev
```

| Variable                 | What it is                                                                      |
| ------------------------ | ------------------------------------------------------------------------------- |
| `GAUGELINE_DATABASE_URL` | the app's own login (a member of `authenticated` only), not the owner's address |
| `GAUGELINE_APP_URL`      | the public address; `https://` makes cookies `Secure`                           |
| `GAUGELINE_AUTH`         | `stand-in`. Anything else is "not configured" and every page answers 503        |
| `GAUGELINE_STANDIN_*`    | the stand-in's signing secret and its list of addresses and user ids            |

The stand-in has no mail server: the link is printed in the terminal that runs it. It refuses to start
when `NODE_ENV=production`. The browser test (`pnpm hosted:e2e`) and the database tests
(`pnpm exec vitest run apps/hosted`) need a Postgres server you can create databases on; see
[data model and tenancy](/hosted/data-model).

## The stand-in and what replaces it

Sign-in sits behind an interface, `AuthProvider` (`requestLink`, `exchangeLink`, `verify`). The stand-in
signs an HS256 token with the claims Supabase Auth puts in an access token: `sub`, `aud`
(`authenticated`), `role` (`authenticated`), `email`, `session_id`, `aal`, `is_anonymous`, `iat` and
`exp`. That is what the policies read through `auth.uid()`, so they run here exactly as they will. No
Supabase account or project exists; nothing here reaches one.

What the owner creates when the real project is made (none of this exists yet; the names are from
Supabase's auth source, and the vendor's own pages were not reachable when this was written):

1. A Supabase project, and its Postgres.
2. Auth: the email provider on, passwords off, "confirm email" on, sign-ups off (people are invited into
   an organisation), a 15-minute link expiry, and the app's address as the site URL and redirect URL.
3. Mail: custom SMTP (Resend) so links come from the product's own domain.
4. The token's signing key, and the same key (or its public key set) given to the app so `verify` can
   check tokens. The app verifies the token itself; it does not ask Supabase on each request.
5. The app's login role (NOINHERIT, a member of `authenticated`), and its address as
   `GAUGELINE_DATABASE_URL`.
6. A Supabase-backed `AuthProvider`, and `GAUGELINE_AUTH` set to it.

## Not here yet

- Refresh tokens: the stand-in's session lasts 8 hours and then asks for a new link.
- Rate limits on asking for a link (the real provider has its own).
- Creating an organisation and inviting people (agencies, X66).
- Adding a site and verifying that you own it, and the nightly time. The hosted service cannot check a
  site until ownership is verified, so adding sites has its own change.
