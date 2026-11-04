# Security

## Read-only

A check never changes anything. Every request to a checked site is a `GET` or a `HEAD`, sent
through one module (`packages/core/src/fetcher.ts`) that refuses any other method.

## How much a run requests

Each run samples a fixed amount and never more. The numbers live in one frozen object,
[`packages/core/src/limits.ts`](../packages/core/src/limits.ts), and a test pins them:

| What                             | At most |
| -------------------------------- | ------- |
| Same-site links                  | 30      |
| Images                           | 20      |
| Sitemap pages                    | 25      |
| Feeds                            | 3       |
| JavaScript files                 | 15      |
| Addresses inside structured data | 12      |
| Requests at the same time        | 5       |
| Redirect hops followed           | 10      |
| Body read per response           | 5 MB    |

Samples are the first ones in document order, so the same page gives the same sample every run.
There are no flags to raise these limits: they are a promise to the site being checked.
