# Check a redirect list

Paste or upload the list of old addresses and where each should go. The list is read **in this
page**: nothing is uploaded or stored. It is checked for:

- **Duplicates:** one old address listed twice. A server uses only one of the destinations.
- **Chains:** a destination that the list redirects again. Every visitor pays for two hops.
- **A row pointing at itself:** a loop.
- **Mixed trailing slashes:** some addresses end with `/` and some don't, so a server that adds or
  removes the slash adds a redirect to each.

<RedirectTool />

Then, if you like, check up to 25 rows live on your domain. That sends one request per old address
(GET, through the same redirect-map code as `gaugeline plan --base`), only to the domain you type,
a few times a minute at most. A list that spans more than one domain is refused.

For the whole list, the destinations themselves and the pages behind them, run the
[plan check](/docs/plan-check#the-301-map) on your own computer.
