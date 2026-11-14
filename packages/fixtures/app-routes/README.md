# app-routes

An invented Next.js source tree for Fernbank Physio, a small physiotherapy clinic whose patients sign in
to see their bookings and bills. It is the folder `gaugeline check ./app-routes --routes --base <address>`
reads in its tests and in docs/protected-routes.md. Nothing here is a real clinic or patient, and none of
it is ever run: Gaugeline reads these files as text and asks a fixture site (`sites/app-routes`) for each
route that expects a session.

| Route               | The code                                                        | The fixture site answers       |
| ------------------- | --------------------------------------------------------------- | ------------------------------ |
| `/`                 | a plain page (in the `(site)` route group)                      | never asked: it is public      |
| `/appointments`     | guarded by `middleware.ts` (its matcher lists it)               | 302 to `/login`: refused       |
| `/account/payments` | the page calls `auth()` and answers when there is no session    | 401: refused                   |
| `/account/invoices` | the page calls `auth()` to greet the patient and renders anyway | 200 with the page: the finding |

The root layout calls `cookies()` for the navigation, and Gaugeline does not read that as a gate: the
root layout wraps every page, public ones included. `gaugeline.consent.json` is the invented owner's
consent for the probing check, so a run started from this folder needs no `--owner-consent`.
