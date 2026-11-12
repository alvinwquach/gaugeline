# ai-agents

An invented family law practice, Larkspur Family Law, on `larkspur.test`. Its robots.txt carries a blanket
`Disallow: /` copied from a staging site, while `gaugeline.ai.json` says the owner wants only AI search
crawlers. The other problems are small:

- `llms.txt` has a title and a summary but no section of links.
- `/.well-known/agent.json` is served but is not valid JSON.
- The phone number and street address are in structured data only; the page text has neither.

All names, numbers and addresses are invented (555-01xx numbers are reserved for fiction).
