# gaugeline init: start from what the site is built on

Setting up a check on a new client site starts with questions you already know the answers to: is it
WordPress or Sanity, where is it hosted, which form does it post to, does it take payments. Gaugeline can
see most of that from the outside, so `gaugeline init` looks and writes the settings files for you to
review.

```sh
npx gaugeline init <site>
```

It reads the home page and up to four pages it links to, and recognises:

| It recognises              | From                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The content system         | The generator tag, the folders and hosts the page's files come from, and a few response headers (WordPress, Sanity, Contentful, Webflow, Framer, Wix and the hosted builders) |
| The framework              | `/_next/` files or a Next.js header                                                                                                                                           |
| The host and the CDN       | Response headers (Vercel, Netlify, WP Engine, Kinsta, Cloudflare and others)                                                                                                  |
| The DNS host               | With `--dns`: the domain's name servers                                                                                                                                       |
| Forms                      | The form's address and embed scripts (HubSpot, Typeform, Formspree, Jotform and others)                                                                                       |
| Payment links              | Stripe and Square links, PayPal.Me, Venmo, Cash App and Zelle details the pages show                                                                                          |
| Analytics and tag managers | Their scripts and their public ids                                                                                                                                            |
| Listing links              | Google Maps, Yelp and TripAdvisor links                                                                                                                                       |

Everything it finds is a hint for you to review, never a decision. A site Gaugeline cannot name gets a
minimal starting point: the sitemap and feeds adapter, which needs no key and works on any site.

## It only looks

Every request to the site is a `GET` of a page the home page links to. Nothing is submitted, no address is
guessed (no `/wp-json`, no `/.env`, no admin screen: a link to a login or an admin page is skipped), and
nothing in the checks that find non-public paths runs. It never writes a key: where an adapter needs one
it names the environment variable for you to set yourself.

It writes only inside the folder you ran it in, through the same safe writer as the other commands that
write files. It never replaces a file that is there: if any of its files exists, nothing is written and it
says which. `--force` replaces plain files (never a folder or a link), and `--dry-run` prints everything and
writes nothing.

## What it writes

| File                      | When                                 | Holds                                                                                       |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `gaugeline.adapters.json` | Always                               | The content systems it recognised, or the sitemap and feeds adapter when it recognised none |
| `gaugeline.payments.json` | A payment detail on the pages        | The payment details the site shows, so a change on one page is caught                       |
| `gaugeline.handoff.json`  | A Sanity project in an image address | The Sanity project id for the [handoff report](handoff.md)                                  |
| `gaugeline.listings.json` | A link to the business's Yelp page   | The Yelp business id for the [listing checks](../connectors/listings.md)                    |
| `gaugeline.cost.json`     | Hosted on Vercel, and linked pages   | The pages the [cost check](hosting-cost.md) visits twice                                    |
| `gaugeline.init.md`       | Always                               | What it saw and the evidence for each setting, the variables to set and what to do next     |

Settings files are JSON and cannot carry comments, so the evidence for each line ("WordPress: generator tag
6.6") is in `gaugeline.init.md`, next to the list of environment variables. Nothing in any file is a key
or a secret, and the same site gives the same files every time.

## Example: a bar's WordPress site with a Formspree form

Lantern Yard is an invented pop-up bar. You built its site on WordPress, it sits on a managed WordPress
host, bookings arrive through a Formspree form and table deposits go through a Stripe link. Start with
`--dry-run` to see what Gaugeline would write:

<!-- fixture: init-bar-wordpress -->

```sh title=Terminal
$ npx gaugeline init lantern-yard.example --dry-run
```

```text title=Output
Gaugeline init: https://lantern-yard.example
Read: /, /menu, /book, /events

Detected
  Content system  WordPress (generator tag "WordPress 6.6" on the home page)
  Host            WP Engine (the response headers)
  Form            Formspree (a form on /book)
  Payment         Stripe link on /book
  Analytics       Google Analytics 4 (G-LANTERN01 on the home page)
  Listing         Google Maps listing (a link on the home page)
  Note: DNS was not read: add --dns to name the DNS host from the name servers.

Would write (--dry-run: nothing was written)
  gaugeline.adapters.json     the content system to read: WordPress
  gaugeline.payments.json     the payment detail the site shows, to be kept the same everywhere
  gaugeline.init.md           what was detected, the evidence for each setting and the next steps

--- gaugeline.adapters.json ---
{
  "adapters": [
    {
      "id": "wordpress"
    }
  ]
}

--- gaugeline.payments.json ---
{
  "payments": [
    {
      "kind": "stripe-link",
      "value": "https://buy.stripe.com/lanternyarddeposit"
    }
  ]
}

--- gaugeline.init.md ---
# What gaugeline init found on https://lantern-yard.example

Written by `gaugeline init https://lantern-yard.example/` from the public pages /, /menu, /book, /events. Review every file before you commit it. Nothing here is a key: the variables below are names for you to set in your own environment.

## What it saw

- Content system, WordPress: generator tag "WordPress 6.6" on the home page
- Host, WP Engine: the response headers
- Form, Formspree: a form on /book
- Payment, Stripe link on /book (stripe-link)
- Analytics, Google Analytics 4: G-LANTERN01 on the home page
- Listing, Google Maps listing: a link on the home page

## Files

- `gaugeline.adapters.json`: the content system to read: WordPress
- `gaugeline.payments.json`: the payment detail the site shows, to be kept the same everywhere

## Variables to set

- `WORDPRESS_URL`: WordPress (scoped key)
- `WORDPRESS_USER`: WordPress (scoped key)
- `WORDPRESS_APP_PASSWORD`: WordPress (scoped key)

## Notes

- DNS was not read: add --dns to name the DNS host from the name servers.

## Next, in order of value

1. Run the first check and read what it says (`npx gaugeline https://lantern-yard.example/`): https://gaugeline.dev/docs/running-a-check
2. Set up the WordPress adapter: set its variables, then check that what is published is live (`npx gaugeline https://lantern-yard.example/ --published`): https://gaugeline.dev/docs/integrations/wordpress
3. Watch the Formspree form: a changed provider or a dead endpoint loses leads: https://gaugeline.dev/docs/forms-and-crm
4. Review gaugeline.payments.json, then keep the payment details the same on every page: https://gaugeline.dev/docs/guides/payments
5. List the pages where a tracker should never run (booking, intake, conditions): https://gaugeline.dev/docs/guides/trackers-on-sensitive-pages
6. Compare the site with its Google, Yelp and TripAdvisor listings: https://gaugeline.dev/docs/connectors/listings
7. Before you hand the site over: who owns what, and can the client get in without you (`npx gaugeline handoff https://lantern-yard.example/`): https://gaugeline.dev/docs/guides/handoff

Set these in your own environment (names only: never put a key in a file or a commit)
  WORDPRESS_URL               WordPress (scoped key)
  WORDPRESS_USER              WordPress (scoped key)
  WORDPRESS_APP_PASSWORD      WordPress (scoped key)

Next, in order of value (the same list is in gaugeline.init.md)
  1. Run the first check and read what it says
     npx gaugeline https://lantern-yard.example/
     https://gaugeline.dev/docs/running-a-check
  2. Set up the WordPress adapter: set its variables, then check that what is published is live
     npx gaugeline https://lantern-yard.example/ --published
     https://gaugeline.dev/docs/integrations/wordpress
  3. Watch the Formspree form: a changed provider or a dead endpoint loses leads
     https://gaugeline.dev/docs/forms-and-crm
  4. Review gaugeline.payments.json, then keep the payment details the same on every page
     https://gaugeline.dev/docs/guides/payments
  5. List the pages where a tracker should never run (booking, intake, conditions)
     https://gaugeline.dev/docs/guides/trackers-on-sensitive-pages
  6. Compare the site with its Google, Yelp and TripAdvisor listings
     https://gaugeline.dev/docs/connectors/listings
  7. Before you hand the site over: who owns what, and can the client get in without you
     npx gaugeline handoff https://lantern-yard.example/
     https://gaugeline.dev/docs/guides/handoff
```

Review the files, then run it again without `--dry-run`. It prints the path of every file it wrote:

```sh
npx gaugeline init lantern-yard.example
```

Set the variables it names in your own environment (a `.env` file you do not commit, or your CI's
secrets), then follow its list in order. For this site the first step is the first check, and the WordPress
step is a `--published` check that compares what the client published with what the pages show.

## Options

| Option            | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `--dry-run`       | Print the files it would write and write nothing                              |
| `--force`         | Replace files that already exist (plain files only: never a folder or a link) |
| `--dns`           | Also read the domain's name servers, to name the DNS host                     |
| `--allow-private` | Allow an address on this computer or a private network                        |

The full table is on the [options page](../options.md). Exit codes: `0` it ran, `2` it could not run (the
site did not answer, or a file was in the way).

## Adding detection for a new adapter

Each adapter's entry file can carry an optional `detect` list: the generator tag it uses, the hosts and
folders its files come from, and the response headers it sets. `gaugeline init` reads those lists and
nothing else, so a new adapter is detected by adding its entry file. See "Writing an adapter" in
[CONTRIBUTING](https://github.com/alvinwquach/gaugeline/blob/main/CONTRIBUTING.md).
