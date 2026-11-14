---
"gaugeline": minor
---

New check `form-redirect-leaks-details`: finds a form whose action or thank-you address (retURL, redirect_to, next) has an email address or phone number written into it, and says "could not check" for a thank-you address only a submit would show.
