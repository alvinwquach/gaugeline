# Tracking rules that point at things that no longer exist

Tag Manager rules outlive the pages they were written for. A download trigger tied to a WordPress
address that was retired three years ago never fires again, and nothing says so: the report just
shows fewer downloads. Gaugeline reads your container export and checks each trigger against the
site as it is now.

## Pointing Gaugeline at your container

Export the container from Tag Manager (Admin > Export container) and save the file next to your
project. Then put `gaugeline.tags.json` in the folder you run Gaugeline from (it moves into the
config file when that arrives), naming the export relative to itself:

```json
{ "container": "tag-manager/GTM-TEST01.json" }
```

Only the file is read. Gaugeline never signs in to Tag Manager and needs no account, key or token.
A missing file, or a file that isn't a container export, stops the run (exit 2) naming it.

## What is read

Gaugeline reads the checked page and the first 4 pages it links to, as sent, without JavaScript.

| Trigger                             | Compared with                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Page View, DOM Ready, Window Loaded | The pages read, the same-site links on them and the sitemap's addresses |
| Click (all elements), Just Links    | Every element (or every link) on the pages read that the trigger allows |
| Form Submission                     | Every form on the pages read that the trigger allows                    |

Conditions on `Page URL`, `Page Path` and `Page Hostname` decide which pages a trigger allows.
Conditions on `Click URL`, `Click ID`, `Click Classes`, `Click Text`, `Click Element`, `Form ID`,
`Form Classes`, `Form Text`, `Form URL` and `Form Element` are compared with the elements on those
pages. Equals, contains, starts with, ends with, matches RegEx (with ignore case) and matches CSS
selector are read, each with its "does not" form.

A trigger is dead when no address meets its page conditions, or when no element on the pages read
meets all its other conditions. The evidence names the rule and the nearest thing that does exist:
the closest address, link, id or form id by spelling. A rule about a download (a media folder such
as `/wp-content/` or `/uploads/`, or a file extension) is compared with the links to files.

Gaugeline never guesses. These are listed under could not check instead:

- trigger types it doesn't read (scroll depth, timers, element visibility, video, history changes);
- conditions on your own variables (data layer, JavaScript or lookup variables) or comparisons it
  doesn't read;
- custom events, which the site's own scripts push and a read without JavaScript doesn't run;
- a trigger limited to pages the run didn't read, such as a members area the sitemap lists but no
  page read links to.

## The checks

- `tags-dead-rules`: a trigger whose address, link, form or element no longer exists.
- `tags-duplicate`: two tags that aren't paused send the same event on the same trigger. GA4 event
  tags are the same when the event name and measurement ID match; any other tag when its type and
  every setting match. Each lead or download is then counted twice.

After the results, one line on stderr says how many triggers were read and how many can fire. It is
left out with `--json` and `--quiet`.

## Analytics installed twice

A tag manager snippet pasted into the head by one person and again by another, or a Google Analytics 4 tag that
lives both in the page's code and in the container, counts every visit twice. It needs no export:
`analytics-loaded-twice` counts the page's own script tags.

- A Tag Manager container (`GTM-...`) found in two or more script tags (the snippet inline, or a `gtm.js`
  address) is installed twice. The `noscript` iframe that goes with the snippet is the other half of one install
  and is not counted.
- A Google Analytics 4 id (`G-...`) named by two or more `gtag.js` addresses, or by two or more
  `gtag('config', ...)` calls, is loaded or configured twice.
- With `--trackers`, a hard-coded GA4 id on a page that also loads a container is looked for inside the container's
  public file (one GET of `www.googletagmanager.com/gtm.js?id=...`, the file every visitor receives, at most three
  containers, read as text and never run). The same id in both is a finding; a different id is two properties
  and is not. A container that cannot be read is could not check, never a pass.
- A tag added by a script after the page loads is not seen, and a paused tag or one whose trigger does not fire here
  is not visible: the evidence says each visit "can" be counted twice.

For a yoga studio whose head and footer both carry the container snippet:

<!-- fixture: analytics-twice -->

```sh title=Terminal
$ npx gaugeline tidewateryoga.example
```

```text title=Output
✗ Analytics are loaded twice on this page
    Tag Manager container GTM-TW1D3R4 is installed 2 times on this page, so every tag in it can fire twice
✗ Analytics are loaded twice on this page
    Google Analytics 4 id G-TIDE000001 is configured 2 times, so each page view is sent twice
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 2 to fix first.
```

The fixture is the invented `packages/fixtures/sites/analytics-twice`. The output is asserted by
`packages/cli/src/__tests__/analytics-twice.test.ts` and checked by `pnpm docs:examples`.

## Example

Against the invented `tag-rules` fixture, a bookshop whose old download trigger still waits for a
`/wp-content/uploads/` link, whose contact form was rebuilt with a new id, and whose newsletter form
fires two copies of the same GA4 tag, version 0.1.0 prints:

```text title=Output
! A tracking rule points at something that no longer exists
    Trigger "PDF downloads (old)" (link click): {{Click URL}} contains "/wp-content/uploads/" matches no link on the 3 pages read; nearest that exists: /files/catalogue.pdf
! A tracking rule points at something that no longer exists
    Trigger "Contact form sent" (form submission): {{Form ID}} equals "contact-form" matches no form on the 3 pages read; nearest that exists: contact-form-2024
! Two tags send the same event at the same moment
    "GA4 - generate_lead" and "GA4 - generate_lead (copy)" both send generate_lead to G-TEST0001 on trigger "Newsletter"
? document-hours-mismatch could not be checked: install @gaugeline/documents to read PDFs (/files/catalogue.pdf)
? document-item-missing could not be checked: install @gaugeline/documents to read PDFs (/files/catalogue.pdf)
? document-price-mismatch could not be checked: install @gaugeline/documents to read PDFs (/files/catalogue.pdf)
? document-unreadable could not be checked: install @gaugeline/documents to read PDFs (/files/catalogue.pdf)
? tags-dead-rules could not be checked: trigger "Members renew": it fires only on pages this run did not read (/members/renew) (/)
? tags-dead-rules could not be checked: trigger "Scroll depth": SCROLL_DEPTH triggers are not read (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, none to fix first.
```

and on stderr:

```text
Tag rules: read 8 triggers from GTM-TEST01; 4 can fire, 2 cannot, 2 could not be checked.
```

The four `document-*` lines are not about tags. The bookshop's page links a PDF catalogue, and without
the optional `@gaugeline/documents` package installed beside `gaugeline` Gaugeline says it could not
read that PDF, rather than skipping it or calling it fine (see [Documents agree](/checks/documents-agree)).

The eight are the export's seven triggers and the built-in All Pages trigger its Google tag uses.
Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/tags.test.ts`.
