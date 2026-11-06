# email-records

An invented bike shop at `bellwether.test`, for the email record checks (G12a). Its DNS answers are
in `dns.json`, which the tests serve through a fake reader: `.test` names are reserved, so no real
resolver is ever asked. Nothing here is a real business or domain.

- Two TXT records start with `v=spf1` (one per sending service): `email-spf-multiple`.
- `_dmarc.bellwether.test` has `p=none`: `email-dmarc-none`.
- The verification TXT record is not an SPF record and is ignored.
