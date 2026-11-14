# Listings off the site

For a bar, a pop-up or a clinic, the listing is seen more than the website. Most "bars near me"
searches end on a Google card, a Yelp page or an Apple Maps pin, and never reach your site. The name,
the hours, the phone number and the website button on those cards are typed into dashboards that
nothing keeps in step with your site, so they drift: a renamed bar keeps its old name for a year, a
Sunday closing time is changed on one listing and not the others, and the website button still points
at a domain nobody renews.

Gaugeline reads the listings you name, read only, and compares them with what your site says. It
changes nothing on any of them.

## Example: a neighbourhood bar that changed its name

The BUCK Tavern (invented, like every business on this page) used to be the Buckhorn. The freelancer
who built its Next.js site renamed everything on the website at the relaunch. Two weeks later nobody
has touched the listings. The site says the bar is open until 2am on Friday and Saturday and closed on
Thanksgiving Day and Christmas Day.

The freelancer puts `gaugeline.listings.json` next to the site's other Gaugeline files. It holds
identifiers only, never a key:

```json
{
  "timeZone": "America/Chicago",
  "google": { "location": "locations/1234567890123456789" },
  "yelp": { "businessId": "the-buck-tavern-fairmont-heights" },
  "apple": { "csv": "apple-business-connect.csv" },
  "bios": [{ "name": "Instagram", "url": "https://links.example/bucktavern" }]
}
```

The Google token and the Yelp key come from the environment, and the Apple file is the export the
owner downloaded from Apple Business Connect:

```sh title=Terminal untested="The Google and Yelp answers are recorded and invented and the site is served in memory: packages/cli/src/__tests__/listings.test.ts runs this command against them and compares the output below."
$ GOOGLE_BUSINESS_PROFILE_TOKEN=... YELP_API_KEY=... npx gaugeline bucktavern.example
```

Gaugeline compares each listing with the site's own LocalBusiness data (its name, phone number,
address and hours) and prints:

```text title=Output
✗ A listing shows different opening hours
    Friday: Google Business Profile says 4pm-1am, your site says 4pm-2am; Saturday: Google Business Profile says 4pm-1am, your site says 4pm-2am (site hours from the page's structured data)
✗ A listing shows different opening hours
    Sunday: Yelp says noon-9pm, your site says noon-10pm (site hours from the page's structured data)
✗ A listing still uses your old business name
    Google Business Profile says "Buckhorn Tavern"; your site says "The BUCK Tavern" (the page's structured data)
✗ A listing shows a different phone number
    Yelp says (217) 555-0163; your site says (217) 555-0142 (the page's structured data)
✗ A listing links to the wrong place
    Google Business Profile: the listing links to buckhorn-tavern.example, which redirects to bucktavern.example
✗ A listing links to the wrong place
    Instagram bio link: the link-in-bio page https://links.example/bucktavern does not link to bucktavern.example
! A listing shows a different address
    Apple Business Connect says "418 Alder Street, Fairmont Heights, IL 62999"; your site says "412 Alder Street, Fairmont Heights, 62999" (the page's structured data)
! A listing doesn't know about a holiday closure
    Google Business Profile has no closure for Thanksgiving (2026-11-26); your site says closed on it (/)
? listing-special-hours-missing could not be checked: Apple Business Connect gives Gaugeline no special hours, so its holiday closures were not compared. (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

8 to look at, 6 to fix first.
```

The Google card still says "Buckhorn Tavern", closes an hour early on the two busiest nights and
sends the website button to the old domain, which only works because it happens to redirect. Yelp has
an old phone number and closes at 9 on Sundays. Apple has the wrong street number. Google has
Christmas Day off but not Thanksgiving, and Apple's export does not carry special hours at all, so
that is listed as something Gaugeline could not compare, not as a pass. The Instagram bio points to a
link page that only links to the old domain. The output is asserted by
`packages/cli/src/__tests__/listings.test.ts`.

Each check that passed also prints a `✓ <id>` line, left out above.

## What each source can and can't read

| Source                      | Needs                                                 | Reads                                                                               | Can't read                                                                                            |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Google Business Profile     | `GOOGLE_BUSINESS_PROFILE_TOKEN` and `google.location` | name, phone, address, website link, weekly and special hours, open status, verified | Anything about a location the token's owner doesn't manage                                            |
| Google Maps (Places API)    | `GOOGLE_PLACES_API_KEY` and `google.placeId`          | name, phone, address, website link, weekly hours, open status                       | Special hours; whether the owner has verified it                                                      |
| Yelp                        | `YELP_API_KEY` and `yelp.businessId`                  | name, phone, address, weekly and special hours, closed for good, unclaimed          | The website link: Yelp's business details don't return it                                             |
| Apple Business Connect      | the CSV you export, named in `apple.csv`              | name, phone, address, website link, hours, status                                   | Special hours. Apple has no public read API, so there is nothing to call                              |
| Instagram and Facebook bios | the link-in-bio address, in `bios`                    | where that link lands, and the links on a link page                                 | The profile itself. Gaugeline never requests Instagram, Facebook, TikTok or any other social platform |

A source that isn't named in `gaugeline.listings.json` isn't read. A source that is named and has no
key is listed as something Gaugeline could not check, with the variable to set. The others still run.

## Setting it up

Put `gaugeline.listings.json` in the folder you run Gaugeline from. The listing checks run only when
it exists: without it they are not run, which is different from passing, and nothing is requested from
Google, Yelp or Apple.

| Entry             | What goes there                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `timeZone`        | The venue's zone, like `America/Chicago`. Decides which date "today" is when closures are compared                        |
| `google.location` | The Business Profile location, `locations/` and its number                                                                |
| `google.placeId`  | The place's Google Maps place id                                                                                          |
| `yelp.businessId` | The last part of the business's Yelp address (`yelp.com/biz/` and then this)                                              |
| `apple.csv`       | The export, relative to this file. With several locations, add `apple.location` with the Location ID or the business name |
| `bios`            | Up to 6 `{ "name", "url" }` entries: the link-in-bio address, never the social profile                                    |

### Google Business Profile

Gaugeline reads a location with the Business Information API and the owner's OAuth access token, in an
`Authorization` header on a `GET`. Google documents one OAuth scope for the Business Profile APIs,
`https://www.googleapis.com/auth/business.manage`, and it can also change a profile. There is no
read-only scope to ask for. Gaugeline never sends anything but `GET` with it, and never prints it, but
treat the token as the owner's: have the owner create it, and revoke it when the audit is done. Check
Google's current list of scopes in the Business Profile API documentation before you rely on this.

### Google Maps (Places API)

For public fields you can use an API key instead, which needs no access to the owner's account. In
Google Cloud, create a key and restrict it to the Places API. Gaugeline asks Place Details only for the
fields it compares and sends the key in the `X-Goog-Api-Key` header, never in the address.

### Yelp

Create an app in Yelp's developer pages for a Fusion API key. Yelp limits how many calls a key can
make in a day; one run makes one.

### Apple Business Connect

Apple publishes no way to read a business's listing from outside, so Gaugeline reads a file. In Apple
Business Connect, export your locations as a CSV and save it next to `gaugeline.listings.json`.
Columns are matched by name, loosely: `Location ID`, `Business Name`, `Address Line 1`, `City`,
`State`, `ZIP`, `Phone`, `Website`, `Hours` (written like `Mon-Thu 4pm-1am; Fri-Sat 4pm-2am`) or one
column per weekday (`Monday`, `Tuesday`, ...), and `Status`. A column that isn't in your export is a
field Gaugeline doesn't compare. The file is only read; it is as fresh as the day it was exported.

### Link-in-bio addresses

Put the address your Instagram or Facebook bio carries in `bios`. Gaugeline opens it like any other
link: it should land on your site, or, for a page of links, link to it. An address on Instagram,
Facebook, TikTok or another social platform is refused, because nothing here is read from a social
platform.

## What you declare on the site's side

The listing is compared with what the site says. Gaugeline uses, in this order:

1. Your declared facts in `gaugeline.facts.json`: a `phone` fact, an `hours` fact, and `text` facts
   with the ids `name` and `address`.
2. The page's LocalBusiness structured data (JSON-LD): `name`, `telephone`, `address`, `openingHours`
   or `openingHoursSpecification`, read from the checked page and the first few pages it links to.

If neither states a name (or phone, address, hours), that comparison is listed as something Gaugeline
could not check, naming what to add.

## How hours are compared

Sites and listings write hours in different shapes: "11am-2am", "11:00-02:00", two shifts a day, a
day that is closed. Gaugeline turns both sides into seven lists of opening intervals in the venue's
local time, then compares day by day:

- A closing time after midnight belongs to the day the bar opens. "Friday 11am-2am" is one interval
  on Friday, so the early hours of Saturday aren't compared with Saturday's opening hours.
- A split shift stays two intervals; touching shifts are joined.
- Only the days the site states are compared. A day the site doesn't mention is left alone. A day a
  listing leaves out is closed.
- Hours are never converted between time zones: every source states local time. The `timeZone`
  decides which date "today" is, for the closures below.

## The checks

| Check                           | Level          | Reports                                                                                                                                      |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `listing-name-mismatch`         | Fix this first | A listing's name is not the site's. "The BUCK Tavern" and "Buck Tavern, The" are the same name                                               |
| `listing-phone-mismatch`        | Fix this first | A different phone number (`+1` and punctuation ignored)                                                                                      |
| `listing-hours-mismatch`        | Fix this first | Hours that differ on a day, with both sides                                                                                                  |
| `listing-address-mismatch`      | Fix soon       | A different house number or ZIP code                                                                                                         |
| `listing-website-wrong`         | Fix this first | The listing's link goes to another host (an old domain, even when it redirects), a page that fails or won't open, or 3 or more redirects     |
| `listing-special-hours-missing` | Fix soon       | The site says it is closed on a date in the next 60 days (a holiday, or a date in structured data) and the listing doesn't have that closure |

Closures on the site are read from `openingHoursSpecification` entries with dates and from sentences
like "Closed on Thanksgiving Day", "Closed December 25" and "Nov 26: closed". A sentence like
"closed Mondays, reopening December 1" is not a closure on December 1.

## When a source can't be read

Nothing here ever turns into a pass. A source that can't be read is listed under "could not be
checked" with its reason, the other sources still run, and the checks that needed it are not marked
as passed.

| Reason                  | What it says                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| No key                  | Which variable to set                                                                                           |
| Key refused (401, 403)  | The key is known and not allowed to read this                                                                   |
| Rate limited (429)      | The service's own retry time, such as "Try again in 120 seconds" or "after 2026-11-11T08:00:00Z"                |
| Permanently closed      | The listing says the business is closed for good, so it isn't compared. If you are open, fix that listing first |
| Unverified or unclaimed | Still compared; the finding says the owner doesn't control the listing yet                                      |

## What Gaugeline never does

- It only reads: `GET` requests, through the same fetcher as every other check, which refuses private
  addresses. It never edits a listing, answers a review or submits a form.
- Keys are read from the environment and nowhere else. They go to their own service in a header, are
  replaced by `[redacted]` in every message, and are never in a finding, a log, the JSON result or the
  report.
- It doesn't scrape. Google, Yelp and Apple are read through their own interfaces or an export you
  made, and a social platform is never requested.
- It makes no model calls: the same input gives the same findings.
