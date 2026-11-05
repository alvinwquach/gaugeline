# leaks

An invented pottery studio for the leaked-key and dataset checks (G12). Nothing here is a real
business, key or dataset.

- `/assets/app.js` ships a Stripe secret key: `secret-in-js`. The key, and the publishable key next
  to it (which must not be reported), are `{{planted:...}}` placeholders the fixture server fills in
  at serve time (`PLANTED` in packages/fixtures/src/server.ts), so no key-shaped string is in the
  repository.
- The third-party `https://widgets.example/chat.js` is not the site's own and is never fetched.
- The image comes from Sanity project `ab12cd34`, dataset `production`. In the `sanity-datasets`
  cassette (packages/testkit) that dataset answers without a token and has an `order` type:
  `dataset-private-types`. Tests never ask Sanity.
