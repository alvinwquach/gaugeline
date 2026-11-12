---
"gaugeline": minor
---

Two new checks for every framework: error-shell-200 finds pages that answer 200 but show an error (a framework error page, or a "Page not found" title), and not-found-200 (a probing check, only with --owner-consent) finds sites where an address that does not exist answers 200 instead of 404.
