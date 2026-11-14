---
"gaugeline": minor
---

A model call can now carry only findings, short evidence snippets and ids: a whole page is refused, secrets, card and IBAN numbers, emails and phone numbers are replaced first, page text is quoted as data, and `describeModelPayload` shows what would be sent without sending it.
