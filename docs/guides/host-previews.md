# Preview addresses that search engines can find

Vercel, Netlify, Cloudflare Pages and AWS Amplify give every commit, branch and pull request its own
copy of the site, at an address you did not choose. Those previews are meant for you and the client to
look at, not for Google. Two things go wrong, and each has a check:

- `host-preview-named`: the live site's own pages, sitemap or feeds name a preview address (a
  canonical, an `og:url`, a language version, a script, a feed entry). Nothing is requested for this
  one; it reads what the live site already serves.
- `host-preview-indexable`: when the live site names a preview address, Gaugeline asks for it once
  with a plain `GET` and reports it when the answer is a page that search engines may index: status
  200, no `noindex` in the robots meta tag or in `X-Robots-Tag`, and a canonical that is missing or
  points at the preview itself.

Gaugeline never guesses a preview name. It asks only for an address the site's own markup, sitemap or
feeds named, and at most three per page.

## Which addresses count

| Host             | Preview or deploy address                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Netlify          | `deploy-preview-12--site.netlify.app`, `branch--site.netlify.app`, a deploy id then `--site` |
| Cloudflare Pages | `hash.project.pages.dev`, `branch.project.pages.dev`                                         |
| AWS Amplify      | `pr-12.appid.amplifyapp.com`, `branch.appid.amplifyapp.com`                                  |
| Vercel           | `project-hash-team.vercel.app`, `project-git-branch-team.vercel.app`                         |

A project's own address (`project.vercel.app`, `site.netlify.app`, `project.pages.dev`) and a branch
called `main`, `master`, `prod` or `production` are the live copy's aliases, not previews, so they
are not matched. The host is read with the URL parser, so `evil.netlify.app.example.com`, an address
with a login in front (`netlify.app@evil.example`) and a path that merely mentions a preview name are
not previews; a port, a trailing dot and capital letters are ignored. A Vercel name counts only when
it holds a 9-character token with a digit, because the pattern cannot tell a project called
`cafe-roasters` from a deploy otherwise.

## What the hosts do by default

Most hosts already tell search engines to stay away from previews. The check matters when that
default does not apply.

- Vercel sends `X-Robots-Tag: noindex` on preview deployments, but not when a custom domain is
  assigned to a non-production branch. It is not access control: anyone with the address can open
  it. Deployment Protection (Vercel Authentication) controls who can.
  [docs: Vercel, "Are Vercel Preview Deployments indexed by search engines?"]
- Netlify sends `X-Robots-Tag: noindex` on Deploy Previews. For branch deploys it is on older
  deploys, not the newest one of each branch, so the latest branch deploy can be indexed.
  [docs: docs.netlify.com, deploy previews and branch deploys]
- Cloudflare Pages sends `X-Robots-Tag: noindex` on every preview deployment, but not on the
  production `pages.dev` address. Cloudflare Access can protect previews.
  [docs: developers.cloudflare.com, Pages preview deployments]
- AWS Amplify: its pull request previews and branch addresses are documented
  ([docs: Amplify web previews for pull requests]), but no default robots header was found in the
  pages read. `uncited`: add your own `noindex` or turn on access control for the branch.

These pages were read through search results on 11 November 2026, not opened in full: the host's
own docs have the current wording.

## What each answer means

| The preview answers                           | Reported                                             |
| --------------------------------------------- | ---------------------------------------------------- |
| 200, no noindex, canonical its own or missing | Yes: it can be indexed                               |
| 200 with `noindex` (header or meta)           | No                                                   |
| 200, canonical on another host                | No: search engines are told to prefer the other page |
| 401 or 403                                    | No: protected, behind a login                        |
| A redirect to another host, 404               | No                                                   |
| No answer, or a page too large to read        | Could not check, never a pass                        |

## Example

Fernlight Cafe is an invented client: a neighbourhood cafe whose site you built and keep up. While
checking the menu page with the owner you sent them a Netlify deploy preview, and the sitemap
plugin picked that address up when the site was rebuilt.

Run `npx gaugeline fernlight-cafe.example` and, version 0.1.0 prints:

```text title=Output
✗ A preview of the site can be found by search engines
    deploy-preview-12--fernlight-demo-0000.netlify.app/menu answers 200 with no noindex in meta robots or X-Robots-Tag and no canonical elsewhere
✗ The live site names a preview address
    1 place names a preview address (Netlify pull request preview): sitemap deploy-preview-12--fernlight-demo-0000.netlify.app/menu
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/host-previews.test.ts`, which serves the invented site locally and maps
the preview name to the fixture server, so nothing is requested from a real host. (It is not a
`pnpm docs:examples` example: the preview is another host than the one you type, and Gaugeline only
follows other hosts that resolve to public addresses.)

What to do with it: in the site's settings, build the sitemap and canonical addresses from the live
domain instead of the host's per-deploy address (`DEPLOY_PRIME_URL` on Netlify, `VERCEL_URL` on
Vercel, `CF_PAGES_URL` on Cloudflare Pages, `AWS_BRANCH` on Amplify), rebuild, and run the check again.
For the preview itself: turn on the host's protection for previews (Vercel Authentication, Netlify
password protection, Cloudflare Access, Amplify access control), or send `noindex`. If the preview
was already indexed, ask for its removal in Search Console and keep the protection on, because
`noindex` only takes effect after a search engine visits again.

## What is not covered

- A preview address that is only in a setting (not named by the live site) is not read in this
  version: Gaugeline does not request an address it was not given by the site.
- A preview used as a canonical on a Next.js, Astro, SvelteKit, Angular, Gatsby, Hydrogen or static-generator
  site (Hugo, Jekyll, Eleventy, Docusaurus, VitePress) is also reported by that framework's own
  check (`next-preview-canonical`, `astro-preview-canonical`, `sveltekit-preview-canonical`,
  `angular-preview-canonical`, `gatsby-preview-canonical`, `hydrogen-preview-canonical`, `static-preview-canonical`). So that the
  site is not told twice, `host-preview-named` and `host-preview-indexable` leave that site's
  canonical, `og:url` and sitemap entries on `vercel.app`, `netlify.app` and `pages.dev` to it, and
  leave links to `temp-host-links`. They still read language versions, scripts, feeds and Amplify
  addresses on those sites.
- `amplifyapp.com` is not in the list `temp-host-links` and `temp-host-canonical` use for
  `vercel.app`, `netlify.app` and `pages.dev`; these two checks cover Amplify addresses by pattern.
