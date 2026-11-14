# listings-bar

An invented neighbourhood bar, The BUCK Tavern (renamed from the Buckhorn), for the listing checks (N15).
It is served in memory as `bucktavern.example` (`staticSite` in packages/testkit), never over a socket.
Nothing here is a real business; the phone number is in the 555-01xx range reserved for fiction.

The site says: Mon-Thu 4pm-1am, Fri-Sat 4pm-2am, Sun noon-10pm; closed Thanksgiving Day and Christmas Day.
`gaugeline.listings.json` names an invented Google location, Yelp business, Apple export and bio link;
their answers are in the `listings-bucktavern` cassette (packages/testkit) and `apple-business-connect.csv`.
With the run's clock at 2026-11-10 the listing checks find exactly:

- listing-name-mismatch: Google Business Profile still says "Buckhorn Tavern".
- listing-phone-mismatch: Yelp has the old number.
- listing-hours-mismatch: Google closes at 1am on Friday and Saturday; Yelp closes at 9pm on Sunday.
- listing-address-mismatch: Apple has 418 Alder Street.
- listing-website-wrong: Google links to buckhorn-tavern.example (which redirects), and the Instagram bio's link page links only to the old domain.
- listing-special-hours-missing: Google has Christmas Day closed but not Thanksgiving.
