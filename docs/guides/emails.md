# Transactional emails: the emails customers get

An order confirmation or a booking request is the page a customer reads right after they pay or ask,
and it carries the same things the website does: links, prices, a phone number, a payment handle. A
button that goes to `localhost`, an order number that still says `{{order_id}}` or last year's Venmo
handle are the same faults a page check finds, in a place no page check looks. `gaugeline emails`
reads the emails your project has already rendered to HTML and runs the checks on them.

Gaugeline reads, and never renders. Rendering an email means running your template code, and
Gaugeline never executes what it checks. Every email framework can write HTML, so your project
renders and Gaugeline reads the files. Nothing is ever sent: there is no test send, no mail account
and no key.

## Get the emails as files

Write the rendered HTML of each email into one folder, with the sample data a real order would have
(a template rendered with no data is how `{{order_id}}` reaches the folder in the first place, and
that is what the placeholder check is for). Name each file for the email, and put the language before
the extension when the email has more than one: `order.en.html` and `order.es.html` are one email in
two languages, `welcome.html` has one. A `.txt` with the same name beside an `.html` is its plain-text
version.

- **React Email.** The project's CLI has an export command (`email export`) that writes each template
  in the emails folder to a static `.html` file. Run `npx email export --help` for the options in your
  version.
- **MJML.** The `mjml` command compiles `.mjml` files to HTML: `npx mjml emails/*.mjml -o out/` writes
  one `.html` for each.
- **Anything else.** A tool that can save an email as HTML, such as the "export HTML" button in an
  email editor, works the same way.

These two commands are written from memory: the React Email and MJML documentation could not be
reached when this page was written, so no line of theirs is quoted. If your version names an option
differently, its `--help` is right and this page is not.

## Example: a pop-up's order and booking emails

Marlowe Street Pop-Up is an invented pop-up kitchen. It takes orders and bookings by email, and its
export wrote six emails. Its settings files (`gaugeline.payments.json` with its Venmo handle,
`gaugeline.facts.json` with its phone number, and `gaugeline.emails.json`, below) sit in the folder
the command is run from.

```sh title=Terminal untested="Runs the built command against an invented folder of files. packages/cli/src/__tests__/emails-docs.test.ts runs it (the docs runner points commands at a fixture site, and this one reads a folder) and compares the output with the block below."
$ npx gaugeline emails ./emails
```

```text title=Output
Read 6 emails in emails, 2 with a text version. Nothing was rendered, run or sent.
No request was made. Add --base https://your-site.example to check the links and images on your site.

✗ A link in an email only works on the developer's computer
    emails/booking-request.html:14 1 relative link and 1 link to this computer or a private network: line 14 http://localhost:3000/bookings/42, line 15 /menu
✗ A payment handle differs from yours
    emails/receipt.html:13 Venmo "@marlowe-old" on /receipt.html ("Pay the balance with Venmo: @marlowe-old"); configured "@marlowe-popup"
✗ A fact about your business differs between pages
    emails/receipt.html:14 phone: declared "(415) 555-0132"; /receipt.html has "(415) 555-0199" (text)
! An email still has template variables in it
    emails/order-confirmation.html:26 1 placeholder left in: line 26 {{order_id}}
! An image in an email will not load in an inbox
    emails/welcome.html:11 2 images will not load: line 11 /mail/logo.png (relative path), line 13 http://marlowe-popup.example/mail/hero.jpg (http)
· An email has no plain-text version
    emails/booking-request.html has no emails/booking-request.txt beside it
· An email has no plain-text version
    emails/order-confirmation.html has no emails/order-confirmation.txt beside it
· An email has no plain-text version
    emails/receipt.html has no emails/receipt.txt beside it
· An email has no plain-text version
    emails/welcome.html has no emails/welcome.txt beside it
? broken-links could not be checked: no --base, so the links and images were not requested (emails)
? links-via-redirect could not be checked: no --base, so the links and images were not requested (emails)
? images-broken could not be checked: no --base, so the links and images were not requested (emails)
? payment-link-dead could not be checked: no --base, so the links and images were not requested (emails)

9 to look at, 3 to fix first.
```

Each finding starts with the file and the line in the rendered HTML, so the fix is one search away.
The booking email's "check the request" button points at a development server and its menu link is a
bare path: both fail in every inbox. The receipt tells customers to pay a handle the business gave up
and prints a phone number nobody answers. The confirmation never filled in the order number. Each
passed check also prints a `✓ <id>` line, left out above.

The command exits 0 whatever it finds. In CI add `--ci`, which exits 1 when there is a "Fix this
first" finding.

## What runs on each email

| What                  | Checks                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The four email checks | `email-relative-link`, `email-preview-placeholder`, `email-no-text-part`, `email-image-not-absolute`                                  |
| Links and images      | `broken-links`, `links-via-redirect`, `images-broken` (only with `--base`)                                                            |
| Payment details       | `payment-handle-mismatch`, `payment-handle-unknown`, `payment-handle-inconsistent`, `payment-link-dead` (the last only with `--base`) |
| Facts                 | `facts-match`, `facts-present`, `facts-payment-link`                                                                                  |
| Language versions     | `lang-twin-missing`, `lang-attr-mismatch`, `lang-price-mismatch`, `lang-untranslated`                                                 |

The existing checks read an email as a page whose address is its file, so `mustAppearOn` in
`gaugeline.facts.json` takes `"/receipt.html"`, and the evidence says `/receipt.html`. They use the
settings files the page check uses, read from the folder you run the command in:
[`gaugeline.payments.json`](payments.md), [`gaugeline.facts.json`](facts.md) and
[`gaugeline.languages.json`](languages.md). Prices are compared only where an email states them in
structured data (a schema.org `Offer` in a JSON-LD block), as on a page; Gaugeline does not guess a
price from the words.

## The four email checks

- `email-relative-link` (Fix this first): a link that is a relative path (`/orders/1001`,
  `../menu`, `//cdn.example/x`) or points at `localhost`, `*.local`, `127.0.0.1`, `0.0.0.0` or a
  private network address. An inbox has no site to resolve a path against and nobody else can open
  your laptop.
- `email-preview-placeholder` (Fix soon): a template variable that was never filled in. Handlebars and
  Liquid `{{ name }}` and `{% if %}`, ERB `<% %>`, JavaScript `${name}`, JSX leftovers `{props.name}`,
  `[object Object]`, Mailchimp `*|FNAME|*`, and the words `undefined` and `NaN`. Styles, scripts and
  comments are left out, so CSS braces are never mistaken for variables. The `.txt` version is read too.
- `email-no-text-part` (Worth knowing): an `.html` with no `.txt` of the same name beside it. It runs only
  when you say every email has one, in `gaugeline.emails.json`; otherwise it says it could not run,
  and it never counts as passed.
- `email-image-not-absolute` (Fix soon): an image on a relative path, on a private address or on plain
  `http://`. Images attached inside the message (`cid:`) are fine.

The full entries, with why each matters and how to fix it, are in the [checks reference](/docs/checks).

## Settings: gaugeline.emails.json

```json
{
  "textVersion": true,
  "tracking": [{ "host": "click.mail.example", "param": "url", "path": "/track" }]
}
```

`textVersion` turns on `email-no-text-part`. `tracking` names click-tracking addresses that carry the
real destination in a query parameter, so the link checks look at the destination and not the
wrapper. Microsoft's link scanning (`safelinks.protection.outlook.com`, parameter `url`) and Google's
redirect (`google.com/url`, parameter `q`) are built in. A wrapper whose destination lives on the
provider's server, which is most of them, cannot be read without asking it, so it is checked as it
is. A file that does not read is exit 2, naming the key.

## Links and images: --base

Without `--base` nothing is requested at all, and the report lists the four checks that need the
network as could not check. Name the site the emails link to:

```sh
npx gaugeline emails ./emails --base https://marlowe-popup.example
```

Then Gaugeline asks that site, and only that site, for the links and images the emails point at it,
with HEAD (GET when a server refuses HEAD), the same limits as a page: 30 links and 20 images for each
email, the first in document order. An email with 200 links (social icons, a long footer) is
sampled, and the report says how many: "emails/newsletter.html: 30 of 200 links checked." A link to
another site is never requested, and neither is a relative link, which cannot work anyway.
Gaugeline never asks for an unsubscribe, opt-out or preferences link, on any site, because a GET to
one can unsubscribe the person it was made for.

## Example: a clinic's emails in two languages

Cedar Row Physio is an invented clinic that writes to patients in English and Spanish. Its export
writes `appointment.en.html`, `appointment.es.html` and `reminder.en.html`. `gaugeline.languages.json`
says the default language is `en` and that "Book again" must be translated.

```sh title=Terminal untested="Same as above: packages/cli/src/__tests__/emails-docs.test.ts runs it against the invented clinic folder."
$ npx gaugeline emails ./emails
```

```text title=Output
Read 3 emails in emails (en, es), 0 with a text version. Nothing was rendered, run or sent.
No request was made. Add --base https://your-site.example to check the links and images on your site.

✗ Prices differ between language versions
    emails/appointment.en.html:6 first-visit: 85 USD on /appointment.en.html (en), 95 USD on /appointment.es.html (es)
! A language version of this page is missing
    emails/reminder.en.html:2 1 of 1 language versions are missing: es /reminder.es.html is not in the folder
· Some text wasn't translated
    emails/appointment.es.html:22 1 untranslated: "Book again" on /appointment.es.html (es)
? email-no-text-part could not be checked: gaugeline.emails.json does not say a text version is expected (set "textVersion": true) (emails/appointment.en.html, emails/appointment.es.html, emails/reminder.en.html)
? broken-links could not be checked: no --base, so the links and images were not requested (emails)
? links-via-redirect could not be checked: no --base, so the links and images were not requested (emails)
? images-broken could not be checked: no --base, so the links and images were not requested (emails)
? payment-link-dead could not be checked: no --base, so the links and images were not requested (emails)

3 to look at, 1 to fix first.
```

Files are paired by their name and the language before the extension (`en`, `es`, `pt-BR`; a suffix
that is not a language code is part of the name). The language checks run once for each set of
twins: the price that differs is one finding, the missing Spanish reminder is one finding, and the
untranslated string points at the Spanish file, where it is fixed. A folder with no language
suffixes has none of these checks, and they do not print as passed.

## What it does not do

- It does not render, run or send anything, and it has no option to. Emails are never sent, not even
  a test email.
- It reads files only. It is not connected to your mail provider, so it cannot see what customers
  actually received: for that, see [Orders paid and no receipt sent](/docs/delivery), which counts
  sends without reading a message.
- The evidence for a link or an image never prints its query string, which in a real export can hold a
  customer's token, and text from an email is escaped before it is printed.
- Reading is bounded: at most 200 emails, 1 MB each, four folders deep, with symbolic links and hidden
  folders left alone. Anything left out is said in a note.
