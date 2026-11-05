# Paid downloads and delivery

What happens between someone paying and someone receiving.

A digital product has three handovers: the payment, the file, and the email. Each one can fail quietly, and none of them shows up as an error.

## A file people pay for, on a public address

Asset stores are world-readable by design. That's fine for a brochure and a problem the day the file is something a customer bought. If a page sells something and links straight to an asset URL, it's flagged.

## A download route that hands the file to anyone

Gaugeline asks your download route for the file with no session and no purchase. A route that protects something should redirect to a login or refuse. If it returns the file, everyone with the address gets it.

```text title=Output
✕ A download meant for customers is handed to anyone
  /api/download/7-day-plan → 200 application/pdf
```

## Nothing on the page can be linked to buy

A price and a button with no address behind it means nobody can share a link to the purchase, search engines see no offer, and a script failure turns the page into a brochure.

::: info
The fix is the same in every case: check the purchase in the route, then hand back a short-lived signed link. Never email the asset address.
:::
