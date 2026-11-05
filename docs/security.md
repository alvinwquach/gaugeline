# Security

## Read-only

A check never changes anything. Every request to a checked site is a `GET` or a `HEAD`, sent
through one module (`packages/core/src/fetcher.ts`) that refuses any other method.

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
| Feeds                            | 3       |
| JavaScript files                 | 15      |
| Addresses inside structured data | 12      |
| Requests at the same time        | 5       |
| Redirect hops followed           | 10      |
| Body read per response           | 5 MB    |

Samples are the first ones in document order, so the same page gives the same sample every run.
There are no flags to raise these limits: they are a promise to the site being checked.
