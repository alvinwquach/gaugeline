# Open image optimizers

A site built with Next.js, Nuxt, Astro or Netlify usually resizes its pictures on the server. The
address that does it (`/_next/image`, `/_vercel/image`, `/_ipx/`, `/_image` or `/.netlify/images`) takes
the picture's address in the query, fetches it, shrinks it and sends it back. It is safe only as far as
its **allowlist** is: the list of hosts it may fetch from. If that list is a wildcard, anyone can use the
site to resize and serve a picture from any address on the web. You pay for the bandwidth and the
optimization, your cache fills with other people's images, and your site's name sits on an open relay.
Freelancers who build for bakeries, clinics and shops tend to meet this the day a wildcard was added to
"make the images load".

Gaugeline reads this in two ways. The common one sends nothing.

## What it reads from your settings (no request)

Give Gaugeline the framework settings file in `gaugeline.images.json`, in the folder you run from:

```json title=gaugeline.images.json
{
  "settingsFiles": ["next.config.js"]
}
```

It reads each file as text (never runs it, at most 6 files of 256 KiB) and reports what is certain about
the file:

- `image-optimizer-allowlist-wide` (Fix this first): a hostname made only of wildcards (`"**"`,
  `"**.com"`), a `remotePatterns` entry with no hostname (an `https`-only pattern), a `domains` list that
  holds a wildcard, or a Netlify `remote_images` expression that matches every address.
- `image-optimizer-allowlist-unanchored`: a Netlify `remote_images` expression that does not start with
  `^` and end with `$`, so an allowed address anywhere in the image address satisfies it.

A tight list gives no finding. This is a statement about the file, not about the running site: a site can
deploy a different file than the repository holds.

If a page uses one of these addresses and no settings file was given, the run lists it as **could not be
checked**: whether the address fetches only the hosts you listed is not visible from the page.

## What it asks the running site (a probing check)

`image-optimizer-open` is the proof, and it is a **probing** check: it makes the checked site's own server
fetch an outside picture. It is off unless you pass `--owner-consent` (or have a `gaugeline.consent.json`),
and it is for **sites you own or have permission to test**. It also needs an address you chose:

```json title=gaugeline.images.json
{
  "imageOptimizerProbeUrl": "https://test-pictures.example/gaugeline-probe.png",
  "settingsFiles": ["next.config.js"]
}
```

Choose a small image on a host you control that is **not one of your image hosts** (a `200` from an
allowed host proves nothing). Gaugeline never picks an address of its own, and refuses before sending
anything when the address is not `https`, is an IP address or a private name, is your own host, is a host
your page's image addresses already use, or is a host named in the settings files you gave.

What is sent, exactly:

- one `GET` per optimizer the page uses (at most 5 in a run), to the site's own origin, with the width and
  quality the page itself used (Gaugeline does not guess them) and your address in the query; no cookie;
- no redirect is followed, and the first 1,024 bytes of the answer are read to see whether it is an image,
  then dropped. The body and the query string are never stored, logged or printed;
- the cost to you: one small cache entry per optimizer on your site and a line in its access log.

`200` with an image is the finding. `400`, `403` and `404` pass (the optimizer refused an unlisted host).
Anything else (a redirect, `429`, a server error, a web page) is could not be checked, because it does not
say whether the list is open.

## Example: a bakery whose image settings allow every host

Cedar and Crumb is an invented neighbourhood bakery. The freelancer who built its Next.js site added
`hostname: "**"` to `next.config.js` when the loaf photos would not load. The owner agreed to the probing
checks, and the folder holds the `gaugeline.images.json` shown above.

<!-- fixture: image-optimizer -->

```sh title=Terminal
$ npx gaugeline cedar-crumb.example --owner-consent
```

```text title=Output
✗ Your image settings let the image address fetch from any website
    next.config.js line 4: hostname: "**" lets the image address fetch from any host
✗ Your image address fetched a picture from a website you did not list
    The Next.js image address answered 200 with an image fetched from test-pictures.example/gaugeline-probe.png, a host that is not in your image list: anyone can use your site to resize and serve images from any address
· Shared links have no picture
    no og:image on https://cedar-crumb.example/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is run by `pnpm docs:examples`.

The first finding is the file, found without a request. The second is the proof: the image address fetched
the picture you chose, from a host that is not in your list. The fix is the same for both: list the exact
hosts your pictures come from (and a path prefix where you can) in `remotePatterns`, `domains` or
`remote_images`, remove the wildcard, rebuild, and run the check again.

Every framework is covered the same way. Vercel's `/_vercel/image` uses `images.remotePatterns` in the
project settings, Nuxt Image's `/_ipx/` uses `domains` and `alias`, Astro's `/_image` uses `image.domains`
and `image.remotePatterns`, and the Netlify Image CDN uses `remote_images` in `netlify.toml`. Cloudflare's
`/cdn-cgi/image/` allows origins in the dashboard, which no file holds, so it is not read.

For an active test of the same weakness, run a tool built for it (OWASP ZAP baseline, Nuclei) and read its
result next to this report. Gaugeline does not generate attack traffic.

## Limits

- It reads the settings you give it. It cannot see a setting that lives only in a dashboard.
- Without a probe address and consent it can say "present, not checked", never "open".
- Vendors change the status an optimizer answers for an unlisted host; only `200` with an image is a
  finding, so a change makes a check say "could not be checked", not guess.

Sources: the Next.js `images.remotePatterns`, Vercel image optimization, Nuxt Image IPX, Astro images and
Netlify Image CDN documentation, as read in [ADR-0007](../adr/0007-open-image-optimizers.md).
