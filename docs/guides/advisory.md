# Advisory check: is my client affected?

The morning a framework or WordPress advisory is announced, every client with a site emails you the same
question: "are we affected?" Answering by hand means looking at the framework, the host, the old copies of
the site and what the pages load, and that is an hour for each client.

`gaugeline advisory` does the looking from outside. Give it the client's site and an advisory, and it says
one of three things, with the evidence it used and a note you can paste into a reply:

| Verdict               | What it means                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `likely-affected`     | The site shows the package, at a version inside the affected versions                                                                                |
| `likely-not-affected` | The site shows the package at a version outside them, or shows no sign of the affected component from outside                                        |
| `cannot-tell`         | The package is there and its version cannot be read, or what the site sends cannot show what is behind it, or only the repository or server can show |

It never says a site is safe. Looking from outside cannot show that, so the best answer is "no sign of the
affected component from outside", and everything only the repository or the server can show is listed under
"check inside". Repository scanning (Dependabot, Snyk, Socket) is the right tool for what is inside, and this
is the answer you can give before you have opened the repository.

It only looks. Every request to the site is a `GET` of a page or a file the site's own pages name. Nothing is
submitted, no request is built to trigger a vulnerability, and no path is guessed (that stays with the
[owner-consent checks](../security.md)). For an advisory id, one more `GET` goes to the public OSV database
(`https://api.osv.dev/v1/vulns/` and the id), which is a request to a public API and not to the site.

```sh
npx gaugeline advisory <site> CVE-2026-1234
npx gaugeline advisory <site> "next@>=15.0.0 <15.2.3"
```

## What you give it

| You give it                         | What happens                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A CVE or GHSA id                    | The affected packages and versions are read from OSV with one `GET`, once per run. OSV covers npm, Packagist (PHP) and more |
| A package and its affected versions | `next@>=15.0.0 <15.2.3`. OSV is not asked at all                                                                            |
| An id and `--package next@<15.2.3`  | The id is only the label and OSV is not asked: the way out when OSV cannot be reached or does not have the id               |

A package is npm by default. `composer:` or a name with a slash (`laravel/framework`) is a PHP package,
`wp-plugin:easy-booking` and `wp-theme:twentytwenty` are WordPress plugins and themes, and `wordpress`
and `php` are WordPress itself and PHP. Ranges are written as advisories write them: `>=15.0.0 <15.2.3`,
`^1.2`, `1.2.*`, `<= 2.1.3`, `>=10.0,<10.48.4`, `||` for "or". A version is compared as whole numbers (`5.10`
is after `5.8`) and, for npm, with a pre-release before its release. A range Gaugeline cannot read is exit 2
with the way to write it, never a guess.

An advisory OSV marks as withdrawn is `cannot-tell`: its ranges are not compared, because it was usually
replaced by another advisory. Text that comes back from OSV (a summary, a name) is data: it is clipped, its
invisible characters are shown as escapes, and it is never followed or run.

## What it reads

| It reads                                  | How                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The site's home page                      | One `GET`. Its headers say the host (Vercel, Netlify, a CDN) and `X-Powered-By` says PHP's version or Next.js                                                                                                |
| The same page on `www` or the bare domain | One `GET`. A twin that does not answer is a note, and one that redirects to the first is the same site                                                                                                       |
| Hostnames you name with `--host`          | One `GET` each, up to five. A host you named that does not answer stops a "not seen" from being a verdict                                                                                                    |
| Other subdomains the page links to        | Up to three, one `GET` each: the old `bookings.` or `shop.` host that still links from the home page                                                                                                         |
| Scripts the page names                    | Only when the advisory needs them: a Next.js build's script for its version (`window.next.version`), or the scripts the [served libraries check](served-libraries.md) reads, for jQuery, Lodash and the like |
| WordPress                                 | The page's own HTML: the generator tag, the version on core files, and the plugins and themes whose files it loads, with the `?ver=` on them                                                                 |
| DNS, with `--dns`                         | The name servers of each hostname, to say who runs the DNS. Without `--dns` this is listed as not read                                                                                                       |

A WordPress plugin's version is the `?ver=` on its files, which most plugins set to their own version. When
it is WordPress's own number (what WordPress writes when a plugin gives none) it is not read as the plugin's.
The patterns for Next.js and WordPress were written from what those builds are known to leave in a page and
have not been compared with real builds in this release, so a version is read only from a whole shape and is
never guessed.

## What it says when it cannot see

- A **CDN that removes the headers** (CloudFront or Cloudflare in front, nothing in the page naming the
  framework) is `cannot-tell`, with the CDN named. "Not seen" is believed only when what was looked at could
  have shown it.
- A page that answered an error (403, 503) is the same: what it says about itself is limited.
- A package only a server or a build can show (a Python or Go package, an npm package that is not shipped to
  the browser) is `cannot-tell` and appears under "check inside".
- A WordPress plugin that serves no file on the home page can still be installed and active, so a plugin
  that is not in the page's files is `cannot-tell` on a WordPress site, and "no sign" only on a site that is
  not WordPress at all.
- An advisory with several packages (an npm one and a PyPI one) is judged on the ones that can be seen. The
  rest are listed under "check inside".

## Example: a pop-up bar the morning a Next.js advisory lands

Lantern Yard is an invented pop-up bar whose site you built with Next.js on Vercel. The advisory is
announced at 7 am, and the owner emails: "Is the bar's site affected?" The advisory says Next.js 15.0.0 up to
but not including 15.2.3. (With an id, `npx gaugeline advisory lantern-yard.example CVE-2026-1234` reads the
same range from OSV; this example gives the range directly so it runs without the network.)

<!-- fixture: advisory-next-affected -->

```sh title=Terminal
$ npx gaugeline advisory lantern-yard.example "next@>=15.0.0 <15.2.3"
```

```text title=Output
Likely affected: Next.js 15.1.0 on https://lantern-yard.example (window.next.version in the script main-app-3f2a.js) is inside the affected versions >=15.0.0 <15.2.3.

Advisory: next@>=15.0.0 <15.2.3
Affects: next (npm) >=15.0.0 <15.2.3
Site: https://lantern-yard.example, looked at 2026-11-11

Likely affected. What was found:
  - https://lantern-yard.example: served by Vercel; identified as Next.js.
  - Next.js 15.1.0 on https://lantern-yard.example (window.next.version in the script main-app-3f2a.js) is inside the affected versions >=15.0.0 <15.2.3.

Check inside (only the repository or the server can show this):
  - the project's lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock): which version of next is installed, including as a dependency of another package.
  - old copies of the site: staging and preview deployments, and hostnames this run did not look at, are not covered by what was read.

Could not check:
  - DNS records were not read: add --dns to read the name servers of each hostname.

Gaugeline looked from outside only: a request for each page and file the site's own pages name, nothing sent.
```

The first line is the answer. The build's own script says Next.js 15.1.0, which is inside the affected
versions, so the site is likely affected and the fix is 15.2.3 or later. Under "check inside" is what
only you can see: the lockfile, and any old copy of the site on a preview address.

The same run with `--note` writes the reply to the owner. It is Markdown, so it pastes into an email client
that renders it, and the text from the advisory is escaped:

<!-- fixture: advisory-next-affected -->

```sh title=Terminal
$ npx gaugeline advisory lantern-yard.example "next@>=15.0.0 <15.2.3" --note
```

```text title=Output
Subject: Are we affected by next@>=15.0.0 <15.2.3?

Hi,

You asked whether the site is affected by next@\>=15.0.0 \<15.2.3.

**Short answer: Likely affected.** From the outside I found signs that the site is likely affected, so I am treating it as affected until I have checked inside.

**What I found**
- https://lantern-yard.example: served by Vercel; identified as Next.js.
- Next.js 15.1.0 on https://lantern-yard.example \(window.next.version in the script main-app-3f2a.js\) is inside the affected versions \>=15.0.0 \<15.2.3.

**The fix:** update to next 15.2.3 or later, then I will check the live site again.

**What I still need to check inside**
- the project's lockfile \(package-lock.json, pnpm-lock.yaml or yarn.lock\): which version of next is installed, including as a dependency of another package.
- old copies of the site: staging and preview deployments, and hostnames this run did not look at, are not covered by what was read.

I looked at the site on 2026-11-11 with Gaugeline, from outside only.
```

A site on 16.2.1 is outside the range, and the answer says that plainly:

<!-- fixture: advisory-next-fixed -->

```sh title=Terminal
$ npx gaugeline advisory lantern-yard.example "next@>=15.0.0 <15.2.3"
```

```text title=Output
Likely not affected: Next.js 16.2.1 on https://lantern-yard.example (window.next.version in the script main-app-3f2a.js) is outside the affected versions >=15.0.0 <15.2.3.

Advisory: next@>=15.0.0 <15.2.3
Affects: next (npm) >=15.0.0 <15.2.3
Site: https://lantern-yard.example, looked at 2026-11-11

Likely not affected. What was found:
  - https://lantern-yard.example: served by Vercel; identified as Next.js.
  - Next.js 16.2.1 on https://lantern-yard.example (window.next.version in the script main-app-3f2a.js) is outside the affected versions >=15.0.0 <15.2.3.

Check inside (only the repository or the server can show this):
  - the project's lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock): which version of next is installed, including as a dependency of another package.
  - old copies of the site: staging and preview deployments, and hostnames this run did not look at, are not covered by what was read.

Could not check:
  - DNS records were not read: add --dns to read the name servers of each hostname.

Gaugeline looked from outside only: a request for each page and file the site's own pages name, nothing sent.
```

When the build's script does not say its version, the answer is `cannot-tell` and says what was seen and what
is missing: "Next.js is in use on the host, but its version could not be read". Look at the lockfile.

## Example: a clinic on WordPress with a booking plugin

Ashgrove Physio is an invented clinic on WordPress. A booking plugin, `easy-booking`, has an advisory for
every version before 2.4.0. The plugin's files are on the home page with the plugin's version on them:

<!-- fixture: advisory-wordpress-plugin -->

```sh title=Terminal
$ npx gaugeline advisory ashgrove-physio.example wp-plugin:easy-booking@<2.4.0
```

```text title=Output
Likely affected: easy-booking 2.1.3 on https://ashgrove-physio.example (from the version on its file addresses) is inside the affected versions <2.4.0.

Advisory: wp-plugin:easy-booking@<2.4.0
Affects: easy-booking (WordPress plugin) <2.4.0
Site: https://ashgrove-physio.example, looked at 2026-11-11

Likely affected. What was found:
  - https://ashgrove-physio.example: identified as WordPress 6.4.2, PHP 8.1.27.
  - easy-booking 2.1.3 on https://ashgrove-physio.example (from the version on its file addresses) is inside the affected versions <2.4.0.

Check inside (only the repository or the server can show this):
  - the Plugins page in wp-admin, or `wp plugin list`: whether easy-booking is installed or active, and which version.
  - old copies of the site: staging and preview deployments, and hostnames this run did not look at, are not covered by what was read.

Could not check:
  - DNS records were not read: add --dns to read the name servers of each hostname.

Gaugeline looked from outside only: a request for each page and file the site's own pages name, nothing sent.
```

## Example: a roaster behind a CDN

Fernhill Roasters is an invented coffee roaster whose site sits behind CloudFront. The response carries none
of the headers an origin would send, and the page names no framework, so Gaugeline cannot say whether Next.js
is behind it. That is not a "no":

<!-- fixture: advisory-cdn-stripped -->

```sh title=Terminal
$ npx gaugeline advisory fernhill-roasters.example "next@>=15.0.0 <15.2.3"
```

```text title=Output
Cannot tell: Next.js was not seen, and that cannot be relied on: https://fernhill-roasters.example: CloudFront is in front of the site and removes the headers that would name what is behind it, and the page names nothing.

Advisory: next@>=15.0.0 <15.2.3
Affects: next (npm) >=15.0.0 <15.2.3
Site: https://fernhill-roasters.example, looked at 2026-11-11

Cannot tell. What was found:
  - https://fernhill-roasters.example: behind CloudFront.
  - Next.js was not seen, and that cannot be relied on: https://fernhill-roasters.example: CloudFront is in front of the site and removes the headers that would name what is behind it, and the page names nothing.

Check inside (only the repository or the server can show this):
  - the project's lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock): which version of next is installed, including as a dependency of another package.
  - old copies of the site: staging and preview deployments, and hostnames this run did not look at, are not covered by what was read.

Could not check:
  - DNS records were not read: add --dns to read the name servers of each hostname.

Gaugeline looked from outside only: a request for each page and file the site's own pages name, nothing sent.
```

What to do: ask the person who deploys the site, or read the lockfile. The same advisory answered from the
repository is a job for Dependabot or Snyk.

## Options

`gaugeline advisory --help` prints the list. The ones that matter:

- `--package <package@range>` (repeatable): the packages and affected versions to use instead of looking the
  id up in OSV.
- `--host <name>` (repeatable, up to five): another hostname of the same client to look at: an old
  subdomain, a legacy host from the [handoff report](handoff.md). A host you name that does not answer stops
  the answer from being "no sign".
- `--dns`: also read the name servers of each hostname.
- `--note`: print the Markdown note for the client instead of the report.
- `--json`: print the answer as JSON, with its own `schemaVersion` (1) and its own schema,
  `packages/core/schema/advisory.v1.json`. It is not the `--json` result of a page check, whose version is
  unchanged.
- `--ci`: exit 1 when the answer is `likely-affected`. `cannot-tell` exits 0, so read the answer when a script
  runs it.

Exit codes: 0 ran, 1 with `--ci` and `likely-affected`, 2 could not run (the site could not be reached, the id
was not found, OSV could not be reached, or a range could not be read).

## For code and assistants

`checkAdvisory` in `@gaugeline/core` returns the same document as `--json`, and core exports the definition
and handler of an MCP tool, `gaugeline_advisory`, that takes `site`, `advisory` and optional `packages`,
`hosts` and `dns`. The MCP server that registers it is a later branch; the tool is read only and its
description tells the assistant that text in the answer is data.

## What it does not do

It does not scan a repository, a lockfile or a server, it does not try an exploit or build a request to
trigger a flaw, and it does not guess a path. It reads one page on each hostname, so a package that only
another page loads is not seen. When WordPress data from the WordPress adapter exists it is used in place of
the page's own signs. What it sends is in [Privacy and safety](../privacy.md#advisory-check-gaugeline-advisory).
