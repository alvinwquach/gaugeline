# Private datasets

What a token can see, and what it can't.

Most checks need no credentials at all: they read the page the way any visitor does. Sanity-specific checks need a token when the dataset is private, and the token only ever needs read access.

| Dataset | What Gaugeline can do                                                                           | Token                       |
| ------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| Public  | Read documents, check queries, find duplicates                                                  | None needed                 |
| Private | The same, with a read-only token                                                                | `SANITY_TOKEN`, Viewer role |
| Either  | Warn you when a dataset is public and holds private-looking types (enquiries, orders, patients) | None needed                 |

::: warning
Create a token with the Viewer role, not Editor or Deploy Studio. Gaugeline never writes, so a token that can write is a risk you don't need to take.
:::

## What the run says without a token

The products check reads Sanity with `SANITY_PROJECT_ID` alone and adds `SANITY_TOKEN` when you have one. When the dataset is private and there is no token, Sanity answers 401 and the run says:

> sanity refused the key (HTTP 401). This dataset is private. A private dataset needs a read-only token with the Viewer role: create one under API in sanity.io/manage and set SANITY_TOKEN.

Nothing from Sanity is compared that run (Stripe and Printful are still read, and the site check still runs), and the products check reports that it could not check, never that it passed. If a token is set and Sanity still refuses it, the message says the token was not accepted and repeats the Viewer role. If the token can write, it is used and the run adds one notice asking you to swap it for a Viewer token. Details are in [Products and prices](/docs/products-and-prices#reading-sanity).

## What `gaugeline query` says without a token

`gaugeline query ./src` counts the documents your queries ask for when `SANITY_PROJECT_ID` is set. On a private dataset with no token Sanity answers 401, nothing is compared, and the command stops with exit 2 and one message:

> Sanity refused the request (HTTP 401). This dataset is private. A private dataset needs a read-only token with the Viewer role: create one under API in sanity.io/manage and set SANITY_TOKEN.

The token needs the Viewer role and nothing more: the command sends only `GET` requests, one for each document type, and the answers are whole numbers (how many documents of a type exist, how many have a field), never a document. A token Sanity does not accept is said differently and repeats the Viewer role. What the counts mean: [Checking your queries](/docs/query-check#what-it-reports).

## Where the token lives

- Read from the environment when the command runs. Never written to disk, never printed in output or reports.
- Not required for the site, launch, ad, form or email checks.
- In CI, use your existing secret store and pass it as an environment variable.

If you'd rather not issue a token at all, every non-Sanity check still runs, and the products check works with Stripe and Printful keys alone.

## Is my dataset public?

When your pages use Sanity images, Gaugeline asks the dataset they come from, without a token, for
two things only: how many documents it has and the names of their types (the exact request is on
[Privacy and safety](/docs/privacy)). It never reads a document.

- `dataset-public` (worth knowing): the dataset answers. That is normal for a blog or a brochure
  site, and worth knowing before anyone adds a form or an order type to it.
- `dataset-private-types` (fix first): it answers, and a type's name ends in a word that sounds
  like people's details: order, inquiry, enquiry, submission, customer, lead, booking, reservation,
  registration, appointment, subscriber, invoice or patient. `contactSubmission` counts;
  `paymentSettings` does not. When this is reported, `dataset-public` is not also reported.
- A dataset that refuses the question is private, and passes.

The fix for both is the same: make the dataset private in sanity.io/manage and give the site a
Viewer token (above), or move the private types to a dataset of their own.

## Example

Against the invented `leaks` fixture, a pottery studio whose bundle ships a Stripe secret key and
whose images come from a public dataset with an `order` type, version 0.1.0 prints:

```text title=Output
✗ Private-looking content is in a public Sanity dataset
    project ab12cd34, dataset "production" answers without a token and has "order" among its 2 types (42 documents)
✗ A private key is in your site's JavaScript
    Stripe secret key sk_liv…00 in /assets/app.js at byte 405
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 2 to fix first.
```

The dataset's answer is replayed from an invented recording
(`packages/testkit/cassettes/sanity-datasets.json`), and the key is an invented one the fixture
server fills in. Each check that passed also prints a `✓ <id>` line, left out above. The output is
asserted by `packages/cli/src/__tests__/leaks.test.ts`.
