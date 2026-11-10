# gated-downloads

An invented one-person running coach (Tideline Coaching) for the download route probe (G26a). Nothing here
is a real business, member or file. It is the probing check `gated-download-open`, so it runs only with
`--owner-consent`; `gaugeline.consent.json` gives that, as the invented owner, to runs started from this folder.

- `/`: links to three download routes. `/api/download/7-day-plan` hands a PDF to anyone (`routes.json`:
  200 application/pdf; the one finding). `/api/download/members-guide` redirects to `/login` and
  `/api/download/class-notes` answers 401: both pass.
- `app/`: invented route files, for `--routes "app/api/**/route.ts"`. Only their names are read.
  `[id]` is asked for the three addresses the page links to. `/api/export` answers 403 (pass).
  `[...path]` has no link to give it an address, so it is listed as not probed and never asked, and
  `stripe/webhook` does not say download, file, deliver or export, so it is never asked.
