# emails-cedar

An invented project for Cedar Row Physio, a small clinic that writes to patients in English and
Spanish. `emails/` holds three rendered emails with the language in the file name:
`appointment.en.html`, `appointment.es.html` and `reminder.en.html`. It is the folder the language
tests in `packages/core/src/emails/__tests__` and docs/guides/emails.md use. Nothing here is a real
clinic or a real patient, and nothing in it is ever run or sent.

What is planted:

- the two appointment emails show a different price for the same visit (85 and 95) in their
  structured data;
- the Spanish one still says "Book again" in English, which `gaugeline.languages.json` lists as a
  string that must be translated;
- `reminder.en.html` has no `reminder.es.html` beside it.
