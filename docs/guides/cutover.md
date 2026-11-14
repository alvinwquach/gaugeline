# Cutover: what changed on the day

Cutover day breaks things nobody was watching: the mail records, the certificate, the old host
name. Take a snapshot of the domain before, and compare it with the same domain after: the
comparison is a checklist that runs itself. Everything here is a lookup. Nothing is changed, and
the only requests to the site are two GETs.

## Before cutover

```bash
npx gaugeline snapshot yoursite.com --out before.json
```

It records, in `before.json`:

- the domain's address records (A, AAAA) and mail records (MX);
- its SPF, DMARC and DKIM text records: DKIM for the selectors named in `gaugeline.cutover.json`
  (a selector is the name your mail provider gave the key, such as `google` or `s1`);
- the certificate's names and expiry, read from the connection of an ordinary GET;
- how `https://yoursite.com/` and `https://www.yoursite.com/` each answer: the status, and where
  a redirect points.

```json
{ "dkimSelectors": ["s1"] }
```

## After cutover

```bash
npx gaugeline cutover --before before.json
```

It reads the same domain again and reports what changed:

| Check                         | Level          | When                                                                      |
| ----------------------------- | -------------- | ------------------------------------------------------------------------- |
| `cutover-mail-changed`        | Fix this first | MX or SPF records differ from the snapshot                                |
| `cutover-canonical-host`      | Fix this first | The bare domain and www don't settle on one address with a 301            |
| `cutover-records-changed`     | Fix soon       | DMARC, a DKIM key, or the address records differ                          |
| `cutover-certificate-changed` | Fix soon       | The certificate no longer covers a name it did                            |
| `certificate-expiring`        | Fix soon       | The certificate expires in under 21 days (under 7, or expired: fix first) |

- Records are compared as sets: the same values in another order are no change.
- A lookup that failed in either run is "could not be checked", never a change.
- A change you meant goes in `gaugeline.cutover.json`, with the reason. It is left out of the
  findings and said once on stderr:

  ```json
  { "expectedChanges": [{ "record": "mx", "reason": "mail moved to the new host" }] }
  ```

  `record` is one of `a`, `aaaa`, `mx`, `spf`, `dmarc`, `dkim`, `certificate` or `hosts`.

- The exit code is 1 when something is fix first, so a scheduled job turns red on the day it breaks.
- `certificate-expiring` also runs in every page check (`gaugeline yoursite.com`): the certificate
  comes with the page's own request, so a nightly run catches a renewal that stopped.
- Domain registration expiry needs the registrar's records, which a lookup can't reach: it is not
  checked, and the command says so instead of guessing.

## Example

The invented Fern and Kiln studio (`fernkiln.example`), read through a stand-in resolver in the
tests.

### The snapshot

`gaugeline snapshot fernkiln.example --out before.json` prints:

```text title=Output
Snapshot of fernkiln.example written to before.json
  Address               A 192.0.2.10
  Mail                  MX 10 mx1.mailhost.example
  SPF                   v=spf1 include:_spf.mailhost.example ~all
  DMARC                 v=DMARC1; p=quarantine
  DKIM                  s1: found
  Certificate           fernkiln.example, www.fernkiln.example; expires 2026-11-23 (15 days)
  fernkiln.example      200
  www.fernkiln.example  301 to fernkiln.example/
```

### The comparison

The new host's DNS template replaced the mail record. `gaugeline cutover --before before.json`
prints:

```text title=Output
Comparing fernkiln.example with before.json (taken 2026-11-07 09:00 UTC)
✗ The domain's mail records changed at cutover
    MX for fernkiln.example was 10 mx1.mailhost.example; now 10 mx.newhost.example
! The site's certificate expires soon
    The certificate for fernkiln.example expires on 2026-11-23: 15 days left (issued by Invented Test CA)
✓ cutover-canonical-host
✓ cutover-certificate-changed
✓ cutover-records-changed

2 to look at, 1 to fix first.
```

and on stderr:

```text
Domain registration expiry needs the registrar's records: not checked. Look it up at your registrar.
```
