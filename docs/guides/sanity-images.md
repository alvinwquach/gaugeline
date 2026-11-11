# Sanity images

Many small-business sites (a bakery, a clinic, a pop-up bar) keep their pictures in Sanity and show
them through its image network, `cdn.sanity.io`. The address of each picture says how Sanity should
prepare it: a width, a height, a crop, a format. The editor uploads a 6000 pixel phone photo; what the
visitor downloads depends only on the address the front end writes. These checks read those addresses.

The first three read the page Gaugeline already fetched. Nothing is requested from Sanity or from the site
beyond that and no key is needed. [Three more checks](#the-checks-that-read-your-dataset) read your dataset with a
read-only token. None of them is a probing check, so none needs `--owner-consent`.

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

## The checks that read your dataset

Three more checks need what the editors set in Sanity Studio, so they read the dataset. They run only when
`gaugeline.adapters.json` names `sanity`, because they send a token to Sanity. Without it they are not run
(they are not passed either), and a run asked for one by id says it could not check.

```json title=gaugeline.adapters.json
{ "adapters": [{ "id": "sanity" }] }
```

Set `SANITY_PROJECT_ID`, `SANITY_DATASET` (`production` when unset) and `SANITY_TOKEN`. The token is a
**read-only** key: create one with the **Viewer** role under API in sanity.io/manage. A public dataset needs no
token, a private one does, and a token with more than the Viewer role is used as it is but Gaugeline only reads.

- `sanity-image-crop-ignored`: an editor set a crop or a hotspot on the picture, and the address the page asks for
  does not carry it. A crop is ignored when no address of the image has `rect`, `fp-x`, `fp-y` or `crop`. A
  hotspot is ignored when the address cuts to a different shape (`w`, `h` and `fit=crop`) with none of those, so
  Sanity cuts around the middle and the heads of a team photo go. Fix: build the address with the image value
  (`urlFor(image).width(800).height(600).url()`), not just its asset.
- `sanity-image-alt-unrendered`: the editor wrote alt text in Studio and the page's `img` has no `alt` attribute or
  an empty one. Only a field named `alt` on the image value is read. Fix: load the field and pass it on, or clear
  it in Studio if the picture is decoration.
- `sanity-image-heavy`: how many of the uploads the page uses are over 500 KB (512,000 bytes) and over 1 MB
  (1,048,576 bytes), with the list, largest first. The size is the upload's `size` in bytes, not what the visitor
  downloads: a resized address is much smaller, and the list says which uploads the page serves whole.

### What is read, and how

Every request is a `GET` of `https://<project>.api.sanity.io/.../data/query/<dataset>` for published documents,
with the token in a header and never in an address. Two kinds of query, built from asset ids that were tested
against the shape `image-<hash>-<width>x<height>-<format>` first; nothing else from the page goes into a query:

- the `size` of the asset documents (40 uploads to a request);
- the published documents that refer to each upload (10 uploads to a request, at most 30 documents a request), from
  which only the image values' crop, hotspot and a yes or no for "has alt text" are kept. The alt text itself is
  never kept, printed or stored, and neither is any other field.

A run reads at most 100 uploads of the page. Anything it cannot read is `could not check`, never a pass: an
upload that belongs to another project or dataset than the ones you set (the token is not theirs), an upload
Sanity has no asset for, an upload used in several places with different crops, a refused token, a rate limit.
Drafts are left out, so a hotspot an editor has not published is not judged.

### What these checks do not see

- CSS. A hotspot on an address with no width and height is could not check, because the page may crop it with
  `object-fit` and `object-position`, which the page snapshot does not hold.
- A crop or hotspot used through some, not all, of an image's `srcset` addresses: the image counts as using it.
- Two uploads of the same picture have two asset ids and cannot be told apart without downloading them.
- `auto=format` on a resized image is advised in the fix text but is not a finding of its own.

### Example with a Viewer token

The invented Harbour Lane Tap Room, a Friday pop-up bar in a converted fishing container (the
`sanity-studio-images` fixture and the `HARBOUR` dataset, all made up). The owner drew a crop on the cocktail menu
board and put the hotspot on the faces in the team photo, but the front end writes its addresses by hand:

```text title="Output with a Viewer token"
! Alt text written in Sanity is not on the page
    1 Sanity image has alt text in Studio that the page does not show: 7c1e2d3f-2400x1600.jpg (empty alt on the page)
! A crop or hotspot set in Sanity Studio is not used by the page
    2 Sanity images ignore what the editor set in Studio: 3a9f0c1d-4000x3000.jpg (hotspot set in Studio, cut to 800 by 800 around the middle), 7c1e2d3f-2400x1600.jpg (crop set in Studio, no rect in the address)
! Uploads the page uses are heavy in Sanity
    3 Sanity uploads used on this page are heavy (2 over 1 MB, 1 between 500 KB and 1 MB), largest first: c4d5e6f7-5000x2000.jpg 2.2 MB (served whole), 3a9f0c1d-4000x3000.jpg 1.4 MB, 7c1e2d3f-2400x1600.jpg 625 KB
! Sanity images are served at the size they were uploaded
    1 Sanity image is served at the size it was uploaded: c4d5e6f7-5000x2000.jpg
! Sanity images are delivered far larger than they are shown
    1 Sanity image is delivered larger than shown: c4d5e6f7-5000x2000.jpg is 5000 px wide for a 1600 px slot (10x the pixels)
· Shared links have no picture
    no og:image on https://harbourlane.test/
? sanity-image-alt-unrendered could not be checked: 1 upload on this page belongs to another Sanity project or dataset than SANITY_PROJECT_ID and SANITY_DATASET name, so it was not read. (/)
? sanity-image-alt-unrendered could not be checked: 1 upload: it is used in several places and only some have alt text, so Gaugeline cannot tell which one this picture is (/)
? sanity-image-alt-unrendered could not be checked: 1 upload: no published document uses it as an image value (/)
? sanity-image-crop-ignored could not be checked: 1 upload on this page belongs to another Sanity project or dataset than SANITY_PROJECT_ID and SANITY_DATASET name, so it was not read. (/)
? sanity-image-crop-ignored could not be checked: 1 upload: it is used in several places with different crops or hotspots, so Gaugeline cannot tell which one this picture is (/)
? sanity-image-crop-ignored could not be checked: 1 upload: no published document uses it as an image value (/)
? sanity-image-heavy could not be checked: 1 upload on this page belongs to another Sanity project or dataset than SANITY_PROJECT_ID and SANITY_DATASET name, so it was not read. (/)
? sanity-image-heavy could not be checked: 1 upload: Sanity has no upload with this id in this dataset. (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

6 to look at, none to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. Run with the `gaugeline.adapters.json` above
and `SANITY_PROJECT_ID`, `SANITY_DATASET` and `SANITY_TOKEN` set. The page's command needs a Sanity project, so the
docs runner cannot run it; `packages/cli/src/__tests__/sanity-studio-images.test.ts` runs it against the invented
dataset and asserts the block above.

## What is not checked here

- Whether the editor's crop and hotspot are applied through CSS, as above.
- `auto=format` on a resized image is advised in the fix text but is not a finding of its own.
- Two uploads of the same picture have two asset ids and cannot be told apart without downloading them.

## Sources

The address shape and parameter names come from the `@sanity/image-url` 1.1.0 package
(`lib/node/urlForImage.js`, `parseAssetId.js`, `README.md`). sanity.io's own documentation could not be
reached when this was written, so the fit and default behaviour of the network are `uncited`.
The "same bytes, same asset" statement is `uncited`. The 1200 pixel, twice-the-slot and 200 pixel
thresholds are Gaugeline's own and proposed.

For the checks that read your dataset: an asset document's `size`, `originalFilename`, `metadata` and the image
value's `crop` (`left`, `top`, `right`, `bottom`) and `hotspot` (`x`, `y`, `width`, `height`), both fractions of the
image, are `@sanity/types` 6.23.0 (`Asset`, `ImageAsset`, `ImageCrop`, `ImageHotspot`, `Image`) [docs]. That a crop
becomes `rect` and a hotspot is used only when both `w` and `h` are given, and that `fp-x`, `fp-y`, `rect` and `crop`
override the image's own values, is `@sanity/image-url` 1.1.0 (`lib/node/urlForImage.js` `fit()`, README `image(source)`,
`focalPoint(x, y)`, `rect(...)`, `crop(mode)`) [docs]. The asset document id `image-<hash>-<w>x<h>-<format>` is
`@sanity/image-url` `parseAssetId.js` and `parseSource.js` `urlToId` [docs]. sanity.io's own pages could not be reached,
so these are `uncited` against Sanity's documentation: that hotspot and crop live on the image value in a document and
not on the asset document (from the type definitions above), the Sanity CDN's default `fit` (the hotspot rule therefore
needs an explicit `fit=crop`), GROQ's `references()` and `_id in [...]` (they are evaluated by groq-js 2.0.1 in the tests,
not read from Sanity's page), a field named `alt` as where editors keep alt text (a convention, not a Sanity field), and
the thresholds: a crop edge of 1 percent, a hotspot 2 percent off centre, an aspect ratio 2 percent different, 500 KB
and 1 MB as 1024-based sizes, and at most 100 uploads to a run.

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
