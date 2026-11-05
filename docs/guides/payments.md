# Payment details everywhere

A wrong payment handle sends a customer's money to a stranger, and nobody finds out until the owner
asks where the money went. Gaugeline treats payment details as facts that must be the same on every
page: it finds every Zelle, Cash App, Venmo and PayPal handle and every Square and Stripe payment
link on the site, and compares them with the ones you set.

## Setting your payment details

Put `gaugeline.payments.json` in the folder you run Gaugeline from (it moves into the config file
when that arrives). Values are public handles and links, never secrets:

```json
{
  "payments": [
    { "kind": "venmo", "value": "@solana-tamales", "label": "Venmo" },
    { "kind": "cashapp", "value": "$SolanaTamales", "label": "Cash App" },
    { "kind": "zelle", "value": "(408) 555-0100", "label": "Zelle" },
    { "kind": "square-link", "value": "https://square.link/u/Sol4Box9", "label": "Tamal box" },
    {
      "kind": "stripe-link",
      "value": "https://buy.stripe.com/solana-gift-28",
      "label": "Gift card"
    }
  ]
}
```

`kind` is `zelle`, `cashapp`, `venmo`, `paypal`, `square-link` or `stripe-link`. A handle can be
written with or without its `@` or `$`, or as its profile link. A Zelle value is the phone number or
email you receive Zelle payments at. A value Gaugeline can't read stops the run (exit 2), naming the
entry.

## What is read, and where

Gaugeline reads the checked page and the first 4 pages it links to, as sent, without JavaScript:

| Kind     | Read from                                                                     |
| -------- | ----------------------------------------------------------------------------- |
| Cash App | `cash.app/$Tag` links, and `$Tag` near the words "Cash App"                   |
| Venmo    | `venmo.com/u/handle` and `venmo.com/handle` links, and `@handle` near "Venmo" |
| Zelle    | a phone number or email near "Zelle"                                          |
| PayPal   | `paypal.me/name` and `paypal.com/paypalme/name`                               |
| Square   | `square.link/u/...` and `checkout.square.site/...`                            |
| Stripe   | `buy.stripe.com/...`                                                          |

Links count wherever they are, in an `href` or written out in the text. A handle written as text
counts only when the provider's name is within 40 characters of it, in the same sentence: `@lulas`
and `$12` look like ordinary text, and the name is what keeps false alarms near zero. A cashtag
starts with a letter, so a price like `$12` is never read as one. Image descriptions (`alt`) and
`aria-label`s are read too, because a QR code's description often holds the handle.

Handles compare without their `@` or `$` and in any letter case. Zelle phone numbers compare by
their digits, so `(408) 555-0100`, `408.555.0100` and `+1 408 555 0100` are the same.

## The checks

- `payment-handle-mismatch`: a handle differs from the one you set for that service.
- `payment-handle-unknown`: a handle for a service you didn't set, or a Square or Stripe link that
  isn't one of yours.
- `payment-link-dead`: a Square or Stripe link answers 404 or 410, or shows the provider's page for
  a link that has been turned off. Each link is requested once with GET, at most 5 per run, and
  nothing is ever submitted.
- `payment-handle-inconsistent`: with no `gaugeline.payments.json`, one service has two different
  handles across the pages read.

A wrong handle in a footer that repeats on 40 pages is one finding listing the pages, not 40: the fix
is one edit, usually in a shared footer or a CMS field.

## Example

Against the invented `payments-popup` fixture, a tamal pop-up whose Spanish page still has an old
Venmo handle, whose order page offers a PayPal nobody set up, and whose gift-card link has been
turned off in Stripe, version 0.1.0 prints:

```text title=Output
✗ A payment handle differs from yours
    Venmo "@solana-tamale" on /es/ ("Paga con Venmo: @solana-tamale"); configured "@solana-tamales"
✗ A payment detail you didn't set is on the site
    PayPal "paypal.me/solanatamales" on /order ("or with PayPal at paypal.me/solanatamales"), not configured
✗ A payment link no longer works
    Stripe link https://buy.stripe.com/solana-gift-28 on 3 pages (/, /order, /es/) says "This link is no longer active"

Checked all 2 links, 1 image, all 3 sitemap pages, all 2 other pages, 1 language version, 1 payment link, all 2 checkout links.
3 to look at, 3 to fix first.
```

The Venmo link on `/` is also requested once, by `facts-payment-link`, which is the "1 payment
link". Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/payments.test.ts`, with Square and Stripe answered from a recorded,
invented cassette and the Venmo profile answered locally, never by the live sites.
