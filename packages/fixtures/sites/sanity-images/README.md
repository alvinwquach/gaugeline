# sanity-images

An invented neighbourhood bakery whose pictures come from Sanity's image network, for the Sanity image
checks (IMG-01). The project id (`p3xk9wq2`) and the asset ids are made up and belong to nothing. Only
the shape of the addresses (`cdn.sanity.io/images/<project>/<dataset>/<asset>-<width>x<height>.<ext>`
and the `w`, `h`, `fit` and `auto` parameters) reproduces what a real Sanity-backed page writes.

- A phone photo with no width in its address: `sanity-image-original`.
- A 400 px slot given a 2400 px wide image: `sanity-image-oversized`.
- The same asset asked for with two sets of parameters in two images: `sanity-image-duplicate`.
- A correct image with a srcset and `auto=format`: no finding.

None of the pictures is ever requested: the checks read the page's HTML and the sizes written in each
address.
