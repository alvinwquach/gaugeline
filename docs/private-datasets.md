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

## Where the token lives

- Read from the environment when the command runs. Never written to disk, never printed in output or reports.
- Not required for the site, launch, ad, form or email checks.
- In CI, use your existing secret store and pass it as an environment variable.

If you'd rather not issue a token at all, every non-Sanity check still runs, and the products check works with Stripe and Printful keys alone.
