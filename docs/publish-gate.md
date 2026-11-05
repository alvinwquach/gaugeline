---
notReleased: true
---

# The publish gate

How the Publish button waits, and its one honest limit.

1. An editor clicks Publish.
2. A Sanity Function loads the page that document renders to, and checks it against the documents around it and systems like Stripe.
3. If everything agrees, the document publishes. If not, the button waits and says why, with a link to the problem.

## The honest limit

The button stops people. A script with an API token can write directly and go around it, so the Function also checks again right after every publish. Anything that slipped past becomes a finding instead of a surprise.
