# sites-file

An invented `gaugeline.sites.json` for `gaugeline run` (X26): three sites, none of them real.
The tests replace `{{clean}}` and `{{noindex-header}}` with the origins of those fixture sites.
`old-shop` points at a port nothing listens on, so it is the site that can't run.
`harbour/` is that site's config folder: its own `gaugeline.*.json` files would go here.
