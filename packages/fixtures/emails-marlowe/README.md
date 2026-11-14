# emails-marlowe

An invented project for Marlowe Street Pop-Up, a pop-up kitchen that takes orders and bookings by
email. `emails/` is what its email export command wrote: six rendered emails and two plain-text
versions. It is the folder `gaugeline emails ./emails` is pointed at in the tests and in
docs/guides/emails.md. Nothing here is a real business, and nothing in it is ever run or sent:
Gaugeline reads the files as text.

What is planted, so the tests and the docs can count on it:

- `order-confirmation.html` still says {{order_id}} (line 26).
- `booking-request.html` links to a localhost address and a relative path.
- `receipt.html` shows an old Venmo handle and a phone number that is not the declared one.
- `welcome.html` has two images that will not load in an inbox.
- `pickup-reminder.html` and `gift-card.html` are clean and each has a `.txt` beside it.

`gaugeline.payments.json`, `gaugeline.facts.json` and `gaugeline.emails.json` are the settings a
project that sends these would keep.
