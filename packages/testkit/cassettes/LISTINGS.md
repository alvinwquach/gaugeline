# Listing cassettes

These four files were written by hand, not recorded: no listing service was asked. The businesses,
places, locations and phone numbers are invented (the phone numbers are in the 555-01xx range reserved
for fiction), and tests never contact Google or Yelp. Each interaction is in the shape the listing
connectors read (packages/core/src/listings/sources), as written from each service's documentation
as remembered when it was written; the owner should re-record them against the real services once with
`GAUGELINE_RECORD=1` and their own keys (see PROGRESS.md, Owner actions) and review the diff.

- `listings-bucktavern`: the invented bar The BUCK Tavern (renamed from the Buckhorn). A Business
  Profile location that still says "Buckhorn Tavern", links to the old domain (which redirects to the
  new one) and has no Thanksgiving closure; a Yelp business with the wrong phone number and Sunday
  hours; a bio link page that links only to the old domain; `www.bucktavern.example` redirecting to the
  bare host.
- `listings-places`: a Places API place with correct details.
- `listings-limits`: a 403 from Business Profile, a 429 with `Retry-After: 120` from Places, and a 429
  from Yelp with a `RateLimit-ResetTime`.
- `listings-closed`: a Yelp business that is closed for good.
