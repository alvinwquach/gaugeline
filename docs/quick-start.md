# Quick start

Gaugeline needs Node.js 18.17 or newer.

```bash
npx gaugeline example.com
```

After the findings, the summary says how much of the site was sampled, for example:

```
Checked 24 of 61 links, 20 of 34 images, 25 of 310 sitemap pages.
```

A kind that was checked in full reads "all 24 links". Kinds with nothing found are left out. The
limits are fixed (see [Security](security.md#how-much-a-run-requests)); there is no flag to raise them.
