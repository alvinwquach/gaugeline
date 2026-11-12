# sanity-plugin-publish-gate

Hold a Sanity publish until the page it renders is right, and check again after every publish. It is read-only: it reads the document and the page, and it never writes to a dataset, publishes, or holds a write key.

It has three parts: a Function you own that checks one page of your site, a Studio plugin (`publishGate`) that holds the Publish button until that check says the page is right, and a post-publish Function that checks again for writes that went around the button. The button asks your Function over one https address and sends only the page address; the override is a person's confirmation and is not recorded anywhere.

Docs: https://github.com/alvinwquach/gaugeline/blob/main/docs/publish-gate.md
