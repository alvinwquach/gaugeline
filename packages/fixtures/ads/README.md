# ads

Invented ads exports for a tapas bar (`tapas-bar.example`), the kind a freelancer is handed by a
small business that runs its own Meta or Google campaign. Nothing here is a real account.

- `meta.csv`: a Meta Ads Manager export. 12 ads over four landing pages, $3,155.24 in all; the
  campaign tags (`utm_*`, `fbclid`) differ between ads that share a page.
- `google.csv`: a Google Ads download with a title and date range above the table, a currency
  column and two `Total:` lines under it.
- `mixed-currency.csv`: one file in euros and dollars; the totals are never added together.
- `no-link.csv`, `no-spend.csv`: exports that cannot be used; `gaugeline ads` exits 2 and lists the
  headers it found.
- `shop.csv`: a Meta export for an invented candle shop on Shopify (`ember-oak.example`, the
  `ad-shop` fixture site). Eight ads over five product pages, $1,440.00 in all: one product sold
  out, one half sold out, one that answers 404 and one that still shows the theme's sample text.
