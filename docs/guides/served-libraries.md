# Served libraries: the old jQuery nobody remembers installing

A shop or a bar built years ago on a theme usually still loads the JavaScript the theme shipped with: a
jQuery from 2016, a Bootstrap from the theme's last update, a Moment.js a plugin pulled in. Nobody chose
those versions on purpose, and advisories get published about them long after the site was built.
`--libraries` reads the script files a page loads, finds which version of a handful of common libraries each
one is, and lists the advisories in Gaugeline's list that name that version, with the version that fixes each.

Gaugeline reports facts. It says "jQuery 1.12.4 is served; advisory CVE-2020-11023 names versions before
3.5.0". It does not say the site is vulnerable, or that anyone could attack it: whether an advisory matters
depends on how the site uses the library, and Gaugeline cannot see that.

It only looks. Every request is a `GET` of a script file the page's own HTML names, nothing is submitted,
and no script is ever run.

```sh
npx gaugeline shop.example --libraries
```

## What it reads

| It reads                    | How                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The scripts the page names  | Every `script src` in the page's HTML, on the site or on another host (a CDN), at most 20 for one page                                  |
| A banner comment            | The comment a build tool writes at the top of a file, with its own tail: `/*! jQuery JavaScript Library v3.6.0`, `//! version : 2.29.4` |
| A version in the code       | A shape only that library has, such as `jquery:"3.5.1",constructor:` or the constant a Lodash build assigns to `VERSION`                |
| The library's own file name | `jquery-3.5.1.min.js`, or `jquery.min.js` in a `/jquery/1.12.4/` or `lodash@4.17.21` folder of a CDN address                            |

A version is read only from a whole shape. A sentence in a comment (`Requires Bootstrap v4.0+`), another
library's constant, a folder that holds other files (`/js/jquery/1.2/slider.js`) and a query string
(`jquery.min.js?ver=3.5.1`) are never a version, and a version that runs on into more numbers is rejected, not
cut short. The file's own text is trusted before its address. Each script is read once, at most 2 MiB of it searched,
and nothing but the version string is kept: no script text reaches a finding or a report. A script the page
does not name is never asked for, and a script several pages name is reported once, on the first.

The banner and code shapes were written from what the libraries' build tools produce, as remembered, and the
tests use invented stand-ins that carry only the shape. They have not been compared with real files: that is
an open item for the owner. When none matches, the version is not guessed.

The libraries recognised today are jQuery, jQuery UI, Lodash, Moment.js, Bootstrap and AngularJS. The
advisories are in `packages/core/src/data/library-advisories.json`: for each, the affected versions, the
page that publishes it and a `verified` flag that is false until someone has compared the entry with its
page. Every entry is unverified in this release, and a finding says so. A library or version that is not in
the list has no advisory in it, which is not a statement that it is safe.

## What it cannot see

Where Gaugeline cannot tell, it says so under could-not-check, never as a pass:

- A file named like a library (`jquery.min.js`) with no banner and no version anywhere: the library is
  known, the version is not.
- Minified files with no library name or version in them, counted in one line. A library bundled into
  such a file with its banner removed is not seen.
- A script that answered an error, was refused (a private address) or could not be reached, or is longer
  than what is read.
- More than 20 scripts on one page: the rest are counted.

## Example: a shop on an old theme

Corner Pantry is an invented client: a neighbourhood shop whose site you built years ago on a theme the
owner never wanted touched. The theme loads jQuery, Moment.js, Lodash and a Bootstrap file, and a minified
theme script of its own.

<!-- fixture: old-theme-shop -->

```sh title=Terminal
$ npx gaugeline corner-pantry.example --libraries
```

```text title=Output
! A JavaScript library the site serves has a published advisory
    jQuery 1.12.4 is served from https://corner-pantry.example/assets/js/jquery.min.js (version read from the file's banner comment). 4 advisories in Gaugeline's list name versions that include it: CVE-2020-11023 (cross-site scripting through HTML with option elements; fixed in 3.5.0), CVE-2020-11022 (cross-site scripting through htmlPrefilter; fixed in 3.5.0), CVE-2019-11358 (prototype pollution through extend; fixed in 3.4.0), CVE-2015-9251 (cross-site scripting in cross-domain Ajax requests; fixed in 3.0.0). The entries in Gaugeline's list have not been compared with the advisories' own pages in this release
? library-with-advisory could not be checked: Bootstrap is served from https://corner-pantry.example/assets/js/bootstrap.min.js, but neither the file nor its address says which version, so it was not compared with the advisories. (/)
? library-with-advisory could not be checked: 1 minified JavaScript file carries no library name or version (theme.min.js), so what it contains was not compared with the advisories. (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, none to fix first.
```

Three libraries have a version Gaugeline can read: jQuery 1.12.4, Moment.js 2.29.4 and Lodash 4.17.21. Only
jQuery has advisories that name its version. The Bootstrap file lost its banner when the theme was built, so
the version is unknown, and the theme's own minified script carries no library name. Each check that passed
also prints a `✓ <id>` line, left out above. The output is asserted by `pnpm docs:examples` in CI.

What to do with it: look where the jQuery file comes from. In a theme it is usually a file in the theme's
folder or a script the theme registers; swapping it for a version past 3.5.0 is often an hour's work, and
the pages that use jQuery are the ones to test afterwards. If the theme depends on an old plugin that breaks
on the newer version, that is the conversation to have with the client, with the list as the thing you hand
over.

## Example: a bar that loads its libraries from a CDN

The Anchor Room is an invented bar whose pages load jQuery and Bootstrap from a CDN, with the version in the
address. Gaugeline reads the version from the address without needing a banner:

```text
https://ajax.googleapis.com/ajax/libs/jquery/1.12.4/jquery.min.js    jQuery 1.12.4
https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.3.7/js/bootstrap.min.js    Bootstrap 3.3.7
```

The finding for a script on another host names its address with nothing after the `?`, because a query
string may hold a key. A third-party script that resolves to a private address is refused by the fetcher,
like any other request, and is listed as could-not-check.

## The check

| Check                   | What it lists                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `library-with-advisory` | Each library and version served on the page that a published advisory names, with the fixed-in version |

It is a "to look at" finding, never "Fix this first": it is a list, not a verdict. It has its entry, with
the technical line, in the [checks reference](../checks.md).

## Running it

```sh
npx gaugeline shop.example --libraries
npx gaugeline shop.example --libraries --json
npx gaugeline run --all --libraries
```

`--libraries` is off by default, so a default run is unchanged. It takes the page check's other flags and
checks the page you give it, not the whole site; run it on the pages whose theme differs (the home page, a
product page, the checkout). `gaugeline run --all --libraries` adds it to every site of a nightly run.

## What it will not do

- It does not say a site is vulnerable, or that a library is unsafe. Ask whoever maintains the theme.
- It does not run a script, test an advisory against the site or send anything to it.
- It does not ask for a path the page does not name, or for a file such as `/package.json`.
- It does not look up advisories at run time: the list is a file in the package, so the same files give the
  same findings, and it grows by a pull request, not by a call to another service.

What the command sends: [Privacy and safety](../privacy.md#served-libraries-libraries).
