# app-routes (site)

The running site for `packages/fixtures/app-routes`, the invented Fernbank Physio source tree. `routes.json` is
what each route answers to a request with no session: `/appointments` redirects to `/login`, `/account/payments`
answers 401, and `/account/invoices` hands over its page (the one finding). `/` is public and is never asked.
