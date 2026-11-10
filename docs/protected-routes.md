# Routes that are hidden, not protected

A route that isn't in the navigation is not a protected route. Asked for without a session, it either refuses or hands the page over.

You build a patient portal for a physio clinic. The "My invoices" link only shows once someone signs in, so nobody can click their way to `/account/invoices` without a login. But a link that is not shown is not a lock. If the page itself never checks who is asking, anyone who types the address, finds it in a search engine, or gets it from a patient's email can read what a signed-in patient would see.

A crawler cannot find this. It follows links, and the route nothing links to is the one that matters. Your code lists every route, so Gaugeline reads the routes from your repository and then asks the running site for each one, as a stranger would.

```sh title=Terminal untested="Needs a folder of source files and a running site, and the docs runner points every example at a fixture website. packages/cli/src/__tests__/protected-routes-docs.test.ts runs the same command against an invented clinic's source folder and site and compares the output with the block under The example."
$ npx gaugeline check ./src --routes --base https://fernbank-physio.example --owner-consent
```

::: info What works today
`gaugeline check <folder> --routes --base <address> --owner-consent` reads the Next.js routes in a folder (the app router: `app/` or `src/app/`), picks the ones your code treats as signed-in only, and asks the running site at `--base` for each of them once, with no session. It reports every route that hands its page over (`route-hidden-not-protected`, "Fix this first"). Routes with a dynamic segment such as `/invoices/[id]` are listed as not probed, because Gaugeline never guesses an id.
:::

::: warning Run it only on sites you own or have permission to test
Reading your source files makes no request. Asking the site for a route that is meant to be private does, so this is a **probing** check: it is off unless you pass `--owner-consent` or add a `gaugeline.consent.json` ([how](options.md#probing-checks-owner-consent-and-routes)). Without consent it exits 2 and asks nothing.
:::

## The example

Fernbank Physio is an invented clinic. Its patients sign in to see their bookings and bills. Its source folder has four routes, and its running site answers each as follows:

| Route               | What the code does                                                                          | The site answers                   |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `/`                 | A plain page for everyone. Not asked.                                                       | not asked                          |
| `/appointments`     | `middleware.ts` has a matcher that lists it, and sends visitors with no cookie to `/login`. | 302 to `/login`: guarded           |
| `/account/payments` | The page calls `auth()` and redirects when there is no session.                             | 401: guarded                       |
| `/account/invoices` | The page calls `auth()` to greet the patient by name, and renders the list either way.      | 200 with the page: **handed over** |

```text title=Output
Read 4 routes under ./src/app: 3 expect a session in the code, 1 does not. Asked 3 routes once each with no session (GET only, no cookie, no Authorization header); no page was stored.

What each route answered:
  /account/invoices  handed over (200), 127 bytes
  /account/payments  refused (401)
  /appointments      redirected to /login (302)

✗ /account/invoices is handed over with no session
    /account/invoices answered 200 with 127 bytes to a request with no session, no cookie and no token. Your code expects a session here (the page calls auth()). File: ./src/app/account/invoices/page.tsx.

1 to look at, 1 to fix first.
```

The finding says what was asked, what came back (the status and the size of the page, never the page), why Gaugeline expected a session (`the page calls auth()`), and the file to open. The `--ci` flag makes the command exit 1 on it.

The test `packages/cli/src/__tests__/protected-routes-docs.test.ts` runs this command against the invented source folder and site and compares the output with the block above.

## How it finds the routes

It reads the Next.js app directory in the folder you give: `app/` or `src/app/` inside it, or the folder itself when it is called `app`. Only the app router is read in this version; a pages-router site reports that it found no app folder (exit 2).

- Every `page` file (`.tsx`, `.ts`, `.jsx`, `.js`, `.mdx`) and every `route` file (`route.ts`, `route.js`) becomes a path: `app/account/invoices/page.tsx` is `/account/invoices`, and `app/api/export/route.ts` is `/api/export`.
- A **route group** in parentheses, `(site)` or `(portal)`, is not part of the path: `app/(portal)/bookings/page.tsx` is `/bookings`.
- A segment in square brackets (`[id]`, `[...parts]`, `[[...parts]]`) marks the route **dynamic**.
- Private folders (`_name`), parallel-route slots (`@name`) and intercepting routes (`(.)name`) are not addresses of their own and are left out.
- The routes are listed in sorted order, so the same folder gives the same list every run.

The files are read as text. Nothing is run, and no package is imported.

## How it decides a route expects a session

A route expects a session when any of these is true, and the finding says which:

- **The page or route handler calls a session helper:** `auth()`, `getServerSession()`, `cookies()` or `currentUser()`.
- **A layout above the page calls one.** The root layout, `app/layout.tsx`, is left out: it wraps every page, public ones included, and a navigation that shows "Sign in" or "My account" says nothing about one route. A layout wraps pages, not route handlers, so it does not count for a `route.ts`.
- **A middleware matcher covers it, and the middleware looks like a gate.** The file is `middleware.ts` (or `proxy.ts`) beside the app folder. Its `config.matcher` is read from the literal in the file (`"/account/:path*"`, a list, or `{ source }` objects). A middleware counts as a gate when it calls a session helper, reads a cookie or an `Authorization` header, answers 401 or 403, or redirects to a sign-in address. One that only adds a header or sets a language does not, so it does not make every page signed-in.

A call in a comment or a string is not a call, and `request.cookies.get(...)` is not `cookies()`. A route no rule marks is not asked. A marketing page returning 200 is correct, and reporting it would drown the real finding.

The list of helper names is short and fixed in this version. A helper with another name (`getSession()`, `supabase.auth.getUser()`, `requireUser()`) is not found, and a route guarded only by it is not asked.

### When the middleware cannot be read

The command prints a note under the summary line when it could not use the middleware, and reads no route from it:

- **No matcher.** The middleware decides in code which paths it guards, and a script cannot read that.
- **A matcher that is not written out in the file** (a variable, a spread, a template with a placeholder).
- **A matcher entry that covers the home page**, such as `/((?!api|_next/static).*)`. It matches nearly everything, so it is not read as a list of signed-in routes.

For a route a middleware guards in code, call a session helper in the page too (which is the safer pattern anyway), and Gaugeline will ask for it.

## What it sends and reads

One anonymous `GET` per route, to the address your route file gives on the site at `--base`:

- **No cookie, no `Authorization` header, no `Referer`.** The command has no option to send a session, a cookie or a token, and refuses a `--base` address with a user name or password in it. It would not make sense to add one: the question is what a stranger gets. Testing one signed-in user against another's data is a different check with different risks.
- **No query string, no form, no `POST`.** The address is the route's own path, under the path of `--base` if it has one.
- **Redirects are not followed.** A 302 to `/login` is the answer, and the login page is not asked for.
- **At most 30 routes per run**, in sorted order, **and at most 5 requests at a time.** The routes beyond 30, and every dynamic route, are listed as not probed with the reason, so a route that was not tested is never silently a pass.
- **The body is read up to 64 KB** to tell a page from a sign-in form (an `<input type="password">`), and then the connection is closed. It is never stored, logged or printed. What stays of an answer is its status, its size, where a redirect went (a path or a host, never its query string) and a label.

The full list is on [Privacy and safety](privacy.md#signed-in-routes-a-probing-check).

## What counts as handed over

| The route answered                                  | Result                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 with a page                                     | **Finding** (Fix this first): `/account/invoices is handed over with no session`, with the status, the size and the file.                                                       |
| 200 with a sign-in form (a password field)          | Pass. The route showed the login page where a visitor would see it, which is a refusal.                                                                                         |
| 200 with nothing in it                              | **Finding** (Worth knowing): `/account responds with nothing`. A route that expects a session and answers with an empty page may be half built, or may return before it checks. |
| 401 or 403                                          | Pass: refused.                                                                                                                                                                  |
| 404                                                 | Pass: not found. Some sites answer 404 on purpose for a stranger. It is shown in the list, so a wrong `--base` is easy to spot.                                                 |
| A redirect to another address                       | Pass: sent to sign in. The address is not followed.                                                                                                                             |
| A redirect to the same address, 5xx, 429, no answer | Could not check, with the reason. Never a pass.                                                                                                                                 |

A sign-in form that starts after the first 64 KB is not found, and the page would be reported as handed over. A site that answers 200 for a stranger with a page that only says "please sign in" (no password field) is reported too: read the page and decide.

## The fix

Check the session inside the page or the route handler, before it renders or reads anything, and answer 401, 403 or a redirect to sign in when there is none:

```tsx
const session = await auth();
if (!session) redirect("/login");
```

A middleware matcher that does not list the route does not protect it. List the route in the matcher, or check in the page itself. Run the command again to see the route answer 302 or 401.

## What it can't see

- **Only the Next.js app router.** The pages router (`pages/`) is not read in this version.
- **Only the routes it can ask without an id.** A dynamic guarded route is listed as `not probed: needs a real id`. Test it yourself with a real id.
- **A session check somewhere Gaugeline cannot read:** a helper with another name, a check inside a component, a reverse proxy or a hosting-level password in front of the whole site. A hosting-level password makes every route answer 401, and the list shows that.
- **A page that is handed over for other reasons.** A route that reads the session only to personalise a public page (a theme cookie read with `cookies()`) is asked, and a 200 is reported as handed over. The finding names why Gaugeline thought a session was expected, so the line can be dismissed in a second.
- **Which user.** It asks as a stranger. It does not test that one patient can't read another's invoices.

Exit codes: 0 ran, 1 with `--ci` and a handed-over page, 2 when it could not run: no consent, no such folder, no app folder in it, or an address that cannot be asked (a private address needs `--allow-private`).
