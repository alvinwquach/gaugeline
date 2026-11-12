# sanity-plugin-publish-gate

Hold a Sanity publish until the page it renders is right, and check again after every publish. It is read-only: it reads the document and the page, and it never writes to a dataset, publishes, or holds a write key.

This release has the post-publish Function, and the request the Publish button will make: a Function you own that checks one page of your site, and a browser call to it that sends only the page address. The Publish button itself comes in the next release.

Docs: https://github.com/alvinwquach/gaugeline/blob/main/docs/publish-gate.md
