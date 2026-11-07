---
"gaugeline": minor
---

gaugeline snapshot <domain> --out before.json records a domain's DNS, mail records, certificate and www behaviour before cutover; gaugeline cutover --before before.json reports what changed (a mail or SPF change is fix first), and every check now warns when the site's certificate expires within 21 days.
