# Trackers on sensitive pages: what loads where visitors share details

A clinic's intake page, a coach's booking page and a page about a health condition are where visitors
tell a business something about themselves. Whatever loads on those pages can learn that the visit
happened. Most clients do not know what their site loads: a pixel was added for an ad campaign, a session
replay tool for a redesign, a tag manager by someone who has left. `--trackers` lists what is there, with
the id each tracker carries, so you can show the client and they can decide what to do about it.

Gaugeline reports facts. It does not say whether a tracker is allowed on a page, whether a form meets any
law or whether a client has a problem. Those questions belong to the client's own counsel; the findings are
written so you can hand them over.

It only looks. Every request is a `GET`, nothing is submitted and no one is logged in.

```sh
npx gaugeline clinic.example/intake --trackers
```

## What counts as a sensitive page

A page counts when any of these is true:

| It has                      | How Gaugeline decides                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A form                      | A `form` in the HTML that collects something. A search box (a GET form with only a search field) is not counted   |
| A form that sends elsewhere | The same, and the finding names the host the form posts to when it is another site (an intake service, a CRM)     |
| An embedded form service    | A HubSpot, Typeform, Pardot, Salesforce, Formstack or Marketo form or embed, even when the HTML holds no `form`   |
| A path you listed           | A path under `sensitivePaths` in `gaugeline.trackers.json`: a page about a condition, a treatment, a booking page |

Gaugeline has no built-in list of sensitive paths. You say which pages are, in the settings file, because
only you and the client know that `/conditions/*` is where the health pages live.

```json title=gaugeline.trackers.json
{
  "sensitivePaths": ["/intake", "/book", "/conditions/*"]
}
```

A path is exact (`/intake`), or a folder with a trailing star (`/conditions/*`). The settings file is
optional; without it, only pages with a form count.

## What it lists

| Kind                  | What Gaugeline recognises                                                               | Shows the id               |
| --------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| Advertising pixels    | Meta pixel, TikTok pixel, LinkedIn Insight Tag                                          | Yes                        |
| Analytics             | Google Analytics 4 (the `G-` measurement id)                                            | Yes                        |
| Tag manager           | Google Tag Manager (the `GTM-` container id), and what its public file holds            | Yes                        |
| Session replay        | Hotjar, Microsoft Clarity, FullStory, LogRocket, Mouseflow                              | Where the code carries one |
| Form service tracking | The tracking code of HubSpot, Pardot and Marketo, the same patterns the lead checks use | No                         |

These ids are public: they sit in the page's own code, and every visitor receives them. A finding shows the
kind and the id and nothing else: no page text, no form field name and no form value.

Gaugeline reads what the page's HTML says, as a crawler receives it. A tracker that a script adds after the
page loads is not seen, and neither is whether a tag actually fires when a visitor arrives: that needs a
browser, and is a later piece of work. Where Gaugeline cannot tell, it says so.

## Tag Manager containers

A page that loads Google Tag Manager shows one id, and the trackers are inside the container. Gaugeline
fetches the container's public file (`GET https://www.googletagmanager.com/gtm.js?id=GTM-...`, the file
every visitor's browser downloads), reads it as text, and lists the tracker ids it holds. It never runs it.
At most three containers are read for a page.

A container holds what it could load, not what it loads on this page: that depends on its triggers, which
Gaugeline does not run. The finding says so, in the same words each time. A container that cannot be read is
listed under could-not-check with the reason.

## Example: a clinic's intake page

Meadowlark Family Clinic is an invented client: a family clinic whose site you built on Next.js and Sanity.
The marketing person added a Meta pixel for a campaign last spring, and a session replay tool during the
last redesign. The intake form posts to the clinic's intake service, which is another company. The clinic's
news page and its home page are fine.

<!-- fixture: clinic-trackers -->

```sh title=Terminal
$ npx gaugeline clinic.example/intake --trackers
```

```text title=Output
· Trackers load on a page with a form or a listed path
    Meta pixel (id 123456789012345) loads on /intake, a page with a form that sends to intake.carelink-forms.example
· Trackers load on a page with a form or a listed path
    Google Analytics 4 (id G-MEAD0W4K1Z) loads on /intake, a page with a form that sends to intake.carelink-forms.example
· Trackers load on a page with a form or a listed path
    Hotjar session replay (id 3400001) loads on /intake, a page with a form that sends to intake.carelink-forms.example
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, none to fix first.
```

The same command on `/blog` and on `/` prints nothing about trackers: the blog has none, and the home page
has Google Analytics but no form, so it is not a page Gaugeline counts. Each check that passed also prints a
`✓ <id>` line, left out above. The output is asserted by `pnpm docs:examples` in CI.

What to do with it: show the client the three lines. Ask who set each one up and what it is for. If a
tracker is not needed on the intake page, take it out of that page's template or restrict it. Whether the
others may stay is the client's question for their own counsel; the list is what you hand over.

## Example: a coach's booking page behind a tag manager

Tideline Coaching is an invented client: a coach who takes bookings through a form on `/book`. The page's
own code has one line, a Tag Manager container. The container is where the trackers were added.

```sh title=Terminal untested="Runs the built command against recorded responses for an invented coaching site and the container it loads. packages/cli/src/__tests__/trackers-docs.test.ts runs it (the docs runner points commands at one fixture site, and this one also reads a Tag Manager container) and compares the output with the block below."
$ npx gaugeline tideline-coaching.example/book --trackers
```

```text title=Output
· Trackers load on a page with a form or a listed path
    Google Tag Manager container (id GTM-ABC1234) loads on /book, a page with a form
· A Tag Manager container on a page with a form or a listed path holds trackers
    Tag Manager container GTM-ABC1234 holds Meta pixel (id 123456789012345); it loads on /book, a page with a form. Whether it fires there depends on the container's triggers, which Gaugeline does not run
· A Tag Manager container on a page with a form or a listed path holds trackers
    Tag Manager container GTM-ABC1234 holds Google Analytics 4 (id G-MEAD0W4K1Z); it loads on /book, a page with a form. Whether it fires there depends on the container's triggers, which Gaugeline does not run
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, none to fix first.
```

The first line is the container itself, as the page loads it. The next two are what its public file holds: a
Meta pixel (the id is in a custom HTML tag) and a Google Analytics 4 tag (the id is in the tag's settings).
Each says that whether the tag fires on `/book` depends on the container's triggers, which Gaugeline does
not run. To see which, open the container in Tag Manager and read the triggers of those two tags.

## The checks

| Check                       | What it lists                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `tracker-on-sensitive-page` | Each tracker in the page's own HTML and scripts, on a page with a form or a path you listed  |
| `tracker-in-tag-manager`    | Each tracker in the public file of a Tag Manager container the page loads, on the same pages |

Both are "Worth knowing", never "Fix this first": they are lists, not verdicts. Each has its entry, with
the technical line, in the [checks reference](../checks.md).

## Running it

```sh
npx gaugeline clinic.example/intake --trackers
npx gaugeline clinic.example/intake --trackers --json
npx gaugeline run --all --trackers
```

`--trackers` is off by default, so a default run is unchanged and asks for nothing from a tag manager. It
takes the page check's other flags. Run it on the pages that matter: the intake page, the booking page, the
condition pages. It checks the page you give it, not the whole site. `gaugeline run --all --trackers` adds
it to every site of a nightly run, for the pages each site's run covers.

## What it will not do

- It does not say a tracker is allowed or not allowed, or call anything a problem of law. Ask the client's
  own counsel.
- It does not submit a form, log in or ask for a path that is not public. The only request beyond the page
  is the container's public file, and only for a page it counts.
- It does not run a page's scripts, so a tag added after load and a tag that does not fire are not seen.
- It does not read cookies, or what a tracker sends.

What the command sends: [Privacy and safety](../privacy.md#trackers-on-sensitive-pages-trackers).
