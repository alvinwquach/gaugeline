# Privacy

## What Gaugeline requests

Gaugeline only asks the site you name for public pages, the same way a search engine or a visitor's
browser would:

- `GET` and `HEAD` requests only. It never submits a form, never sends a `POST`, `PUT`, `PATCH` or
  `DELETE`, and never logs in.
- At most five requests at a time, with the user agent `Gaugeline/0.1 (read-only site check)`.
- Each address once per run.

## What it sends elsewhere

Nothing. A check runs on your computer and the results stay there unless you send them somewhere
yourself.
