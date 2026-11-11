# Security

## Read-only

A check never changes anything. Every request to a checked site is a `GET` or a `HEAD`, sent
through one module (`packages/core/src/fetcher.ts`) that refuses any other method.

The one exception for reads is a documented read-only query endpoint on an adapter's allowlist
(ADR-0006): some content systems (Wix Data, GraphQL-only APIs) answer a read only to a `POST`. The
fetcher sends it only through `fetcher.query()`, to the host the adapter was configured with, at a
path on the list, with a body that is a query: one GraphQL `query` (a `mutation` or `subscription` is
refused), or a JSON object whose keys are the vendor's documented query keys and none is named like a
write. It never follows a redirect, so the key goes to one host, and the contract tests fail an adapter
that builds anything else. `PUT`, `PATCH` and `DELETE` are never sent. Notifications to your own
channels are the other `POST` (ADR-0005).

## Addresses Gaugeline will not request

A checked site must not be able to turn Gaugeline against the computer it runs on or the network
around it. Before every request, and again before every redirect hop, Gaugeline looks the host up
and refuses it if any address it gets back is not on the public internet:

| Range                                | Examples                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Loopback                             | `127.0.0.0/8`, `::1`                                                                                    |
| Private                              | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`                                             |
| Link-local, including cloud metadata | `169.254.0.0/16` (`169.254.169.254`), `fe80::/10`                                                       |
| Carrier-grade NAT                    | `100.64.0.0/10`                                                                                         |
| Unspecified, multicast, broadcast    | `0.0.0.0/8`, `::`, `224.0.0.0/4`, `ff00::/8`, `255.255.255.255`                                         |
| IPv4 inside IPv6                     | `::ffff:127.0.0.1`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` are judged by the IPv4 address they carry |

The connection then goes to the exact address that was checked, with no second lookup, so a DNS
answer that changes in between (DNS rebinding) cannot slip through. The certificate is still checked
against the site's name.

A refused address is reported as "could not run" (exit 2) with one plain sentence:

```
127.0.0.1:4000 points at a loopback address (127.0.0.1), which Gaugeline does not request.
Try: To check a site on your own computer or network, add --allow-private.
```

To check a development server or a site on your own network, pass `--allow-private`.

## How much a run requests

Each run samples a fixed amount and never more. The numbers live in one frozen object,
[`packages/core/src/limits.ts`](../packages/core/src/limits.ts), and a test pins them:

| What                             | At most |
| -------------------------------- | ------- |
| Same-site links                  | 30      |
| Images                           | 20      |
| Sitemap pages                    | 25      |
| Sitemap files read               | 10      |
| Feeds                            | 3       |
| Links in llms.txt                | 10      |
| Apps looked up in the stores     | 5       |
| Calendars (.ics) read            | 3       |
| Other pages (structured data)    | 4       |
| Language versions                | 5       |
| Payment links (Cash App, Venmo)  | 5       |
| Checkout links (Square, Stripe)  | 5       |
| JavaScript files                 | 15      |
| Sanity datasets asked            | 2       |
| Database tables counted          | 20      |
| Hidden-section pages asked       | 5       |
| Pages in switches and freshness  | 16      |
| Next.js draft routes asked       | 4       |
| Download routes asked (consent)  | 10      |
| Framework addresses requested    | 0       |
| Addresses inside structured data | 12      |
| Requests at the same time        | 5       |
| Redirect hops followed           | 10      |
| Body read per response           | 5 MB    |
| Body read per download route     | 1 KB    |

Samples are the first ones in document order, so the same page gives the same sample every run.
There are no flags to raise these limits: they are a promise to the site being checked.

Download routes are the one thing asked with no login, so they are asked only with `--owner-consent`
(or a `gaugeline.consent.json`), on sites you own or have permission to test. What the probe sends and
reads is under [Download routes](privacy.md#download-routes-a-probing-check) on the privacy page.
