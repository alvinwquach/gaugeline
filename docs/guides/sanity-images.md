# Sanity images

Many small-business sites (a bakery, a clinic, a pop-up bar) keep their pictures in Sanity and show
them through its image network, `cdn.sanity.io`. The address of each picture says how Sanity should
prepare it: a width, a height, a crop, a format. The editor uploads a 6000 pixel phone photo; what the
visitor downloads depends only on the address the front end writes. These checks read those addresses.

They read the page Gaugeline already fetched. Nothing is requested from Sanity or from the site
beyond that, no key is needed, and none of them is a probing check, so none needs `--owner-consent`.

## How an address is read

A Sanity image address looks like
`https://cdn.sanity.io/images/<project>/<dataset>/<asset id>-<width>x<height>.<format>?w=800&auto=format`.
The asset id is a hash of the file, so the same upload is always the same asset, and the upload's
size in pixels is in the file name. The parameters (`w`, `h`, `fit`, `crop`, `rect`, `fp-x`, `fp-y`,
`auto`, `fm`, `q`, `dpr`) are the ones the `@sanity/image-url` package writes. Only addresses on
`cdn.sanity.io` are read: a site that puts its own domain in front of Sanity's network is not seen.

## The checks

- `sanity-image-original`: an image is asked for with no `w`, `h`, `max-w`, `max-h`, `min-w` or
  `min-h`, so the visitor gets the upload as it was, and the upload is wider than 1200 pixels. Fix: add
  a width and `auto=format`, or build the address with `urlFor(image).width(800).auto('format').url()`.
- `sanity-image-oversized`: the `width` attribute says the image is shown 400 pixels wide, and the
  smallest version the page offers (the `src` or a `srcset` entry) is more than twice that and at least
  200 pixels more. Twice the slot is allowed for sharp screens. An image with no `width` attribute is not
  judged, and a width set only in CSS is not seen, because Gaugeline does not render the page.
- `sanity-image-duplicate`: one asset is asked for with different parameters by different images on the
  page (a header at 1200 pixels, a card at 400 by 400). An image's own `srcset` is one image and is not
  counted. Each variant is a file for the network to make and for the visitor to download.

## What is not checked here

- Whether an editor's crop or hotspot in Sanity Studio reaches the page, whether the alt text written in
  Sanity is on the page, and which assets used on the site are over 500 KB or 1 MB, all need Sanity's
  own data (a read-only token with the Viewer role). They are a second pull request and are not part of
  this page yet.
- `auto=format` on a resized image is advised in the fix text but is not a finding of its own.
- Two uploads of the same picture have two asset ids and cannot be told apart without downloading them.

## Sources

The address shape and parameter names come from the `@sanity/image-url` 1.1.0 package
(`lib/node/urlForImage.js`, `parseAssetId.js`, `README.md`). sanity.io's own documentation could not be
reached when this was written, so the fit and default behaviour of the network are `uncited`.
The "same bytes, same asset" statement is `uncited`. The 1200 pixel, twice-the-slot and 200 pixel
thresholds are Gaugeline's own and proposed.

## Example

A neighbourhood bakery whose pictures come from Sanity (the `sanity-images` fixture, all invented): the
owner's phone photo of the rye loaf goes out whole in a full-width banner, the pastry case is asked for 2400 pixels wide for a
400 pixel slot, and the Saturday buns are processed twice. Version 0.1.0 prints:

```text title=Output
! Sanity images are served at the size they were uploaded
    1 Sanity image is served at the size it was uploaded: a1b2c3d4-4032x3024.jpg
! Sanity images are delivered far larger than they are shown
    1 Sanity image is delivered larger than shown: 0f1e2d3c-6000x4000.jpg is 2400 px wide for a 400 px slot (36x the pixels)
· One Sanity image is processed and downloaded more than once
    1 asset is processed more than once on this page: 5c6d7e8f-3000x2000.jpg as 2 different addresses (w=1200&auto=format; w=400&h=400&fit=crop&auto=format)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

3 to look at, none to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/sanity-images.test.ts`.
