# hydrogen-preview-link

An invented ceramics store journal page on a Hydrogen storefront that links to a preview deployment
(`marrowlane-preview-4f2a.o2.myshopify.dev`, an invented name that is never resolved outside tests).
The fixture serves two hosts from these files: the store and that preview address, which answers 200
with no `noindex`. For `hydrogen-preview-indexable` (FW-10), run in-process with the fetcher's hosts
map; nothing here is a real business or deployment.
