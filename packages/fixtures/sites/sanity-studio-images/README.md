# sanity-studio-images

An invented pop-up bar, the Harbour Lane Tap Room, whose pictures come from Sanity's image network, for the
three Sanity image checks that read the dataset (IMG-01, part 2): `sanity-image-crop-ignored`,
`sanity-image-alt-unrendered` and `sanity-image-heavy`. The project id (`hl9t4vz6`), the asset hashes and every
document are made up. The dataset the checks read is `HARBOUR` in `packages/testkit/src/sanity-studio-images.ts`,
which holds the same uploads (sizes, crops, hotspots, alt text) this page uses. The page alone fires nothing in
these three checks: they run only with a Sanity dataset to read.

- The team photo: a hotspot on the left in Studio, and an address that cuts it to a square around the middle.
- The menu board: cropped in Studio, asked for with no `rect`; alt text written in Studio, `alt=""` on the page.
- The Friday gallery shot: a hotspot, used correctly (`rect`), alt text shown. No finding.
- The logo: nothing set in Studio. No finding.
- The harbour banner: 2.2 MB, asked for with no width, so it goes out whole.
- An upload deleted from the dataset, one used with two different crops, and one that belongs to another project:
  each is could not check, never a pass.
