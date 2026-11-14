# Forms and CRM tracking

Whether a lead can reach your CRM knowing where it came from.

Gaugeline recognizes Pardot (Marketing Cloud Account Engagement), Salesforce Web-to-Lead, HubSpot, Formstack, Marketo and Typeform on a page, and checks four things without any login. It reads the page's HTML, scripts and links only. It never fills in or submits a form, and it sends no request to a form provider.

<!-- diagram: leads (drawn on the landing page; not reproduced here) -->

- **If you own the site:** If this is wrong, you still get leads: you just can't tell which advert, email or search brought them.
- **If you run marketing:** This is the attribution gap that makes a working campaign look dead in reporting.
- **If you edit content:** If a form on a page you edit is flagged, send it to whoever set up the form.
- **If you build the site:** Checked from the rendered page: the tracking script, its load order, the form action, and the presence of hidden campaign fields.

## The four checks

| Check                               | Id                       | Level          | Why                                                                                  |
| ----------------------------------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------ |
| A form with no tracking on the page | `crm-no-tracking`        | Fix this first | The CRM can't connect the lead to the campaign that brought them.                    |
| Tracking that loads after the form  | `crm-late-tracking`      | Fix soon       | Salesforce documents that this loses first-touch and UTM data.                       |
| An insecure form                    | `crm-insecure`           | Fix this first | Part of the form or its tracking loads over plain http.                              |
| No campaign fields                  | `crm-no-campaign-fields` | Fix soon       | A form posting to a CRM with no `utm_*` or `gclid` inputs; every lead arrives blank. |

Two notes come with them: `forms-many-providers` (worth knowing) when more than one form service is on a page, and `mailto-cta` (fix soon) for a contact button that opens an email instead of a form. Each check's entry in the [checks reference](/checks) has what it catches, why it matters, how to fix it and a technical line.

## Which providers Gaugeline recognizes

Gaugeline reads the page's HTML the way a crawler does and sends no request of its own to a form provider. A provider is recognized from one of three kinds of evidence: the address a form posts to, the address of an iframe, or a script (its address, or a known call inside an inline script). It never submits a form.

| Provider                                    | A form action or iframe on                                             | A script that draws the form                                          | Tracking code looks like                             |
| ------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| Pardot (Marketing Cloud Account Engagement) | `pardot.com` (for example `go.pardot.com`)                             | none: the form is the page in the iframe                              | `pi.pardot.com/pd.js`, or the `piAId` variable       |
| Salesforce Web-to-Lead                      | the `servlet.WebToLead` address on `salesforce.com` (form action only) | none: the form is plain HTML                                          | none of its own                                      |
| HubSpot                                     | `hsforms.com`, `hsforms.net`, `forms.hubspot.com`                      | `js.hsforms.net/forms/...`, or an inline `hbspt.forms.create(` call   | `js.hs-scripts.com/<number>.js`, `_hsq`              |
| Formstack                                   | `formstack.com` and its account subdomains                             | `formstack.com/forms/js.php`                                          | none of its own                                      |
| Marketo                                     | `marketo.com`                                                          | `marketo.com/js/forms2/...`, or an inline `MktoForms2.loadForm(` call | `munchkin.marketo.net/munchkin.js`, `Munchkin.init(` |
| Typeform                                    | `typeform.com` (for example `form.typeform.com/to/...`)                | `embed.typeform.com/...`, or an inline `tf.createWidget(` call        | none of its own                                      |

What each result holds: the **kind** (`form`, `iframe` or `embed-script`), the form's action or the iframe's or script's address, the form's hidden field names, and a **position**. The position is the element's place among every form, iframe and script in the document, so a later check can say whether tracking code loads before or after the form.

How the evidence is read:

- **A host must match on a label boundary.** `forms.hubspot.com` is HubSpot; `example-hubspot.com` and `js.hsforms.net.example.com` are not. Capital letters and a trailing dot in a host (`WEBTO.SALESFORCE.COM.`) make no difference, and an address that starts with `//` is read as `https`.
- **A host alone is not always enough.** `salesforce.com` serves much more than Web-to-Lead, so its form action must be the Web-to-Lead address; Formstack, Marketo and HubSpot scripts must come from the path their form code lives under.
- **Words on the page are not evidence.** A blog post that names Typeform, or a link to `hubspot.com`, is not a form. Only forms, iframes and scripts count.
- **Every element is one result.** The same HubSpot embed twice is two results, and the usual HubSpot snippet (the loader script, then the create call) is two script elements. The tracking script of Pardot, HubSpot and Marketo is not a form: it is what a later check looks for.
- **A form with no recognized provider is still reported**, as `unknown`, so it can be checked for plain `http` like the others.
- **A form drawn by JavaScript is not in the HTML.** When a provider's embed script is on the page and the page holds no form or iframe of that provider, Gaugeline says "forms may be added by JavaScript" and does not guess. A self-hosted or proxied embed on your own domain can be missed for the same reason: Gaugeline does not fetch the provider's script to look inside it.

### Example: a physio clinic's booking page

Harbour Physio is a three-room clinic on a Next.js site. Its booking page has a Web-to-Lead enquiry form, a Pardot iframe from the clinic's marketing agency, and a newsletter box that HubSpot draws after the page loads. The page, with the parts that matter:

```html title=Booking page
<script src="https://pi.pardot.com/pd.js"></script>
<form action="https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8" method="POST">
  <input type="hidden" name="oid" value="00Dxx0000000000" />
  <input type="hidden" name="utm_source" />
  <input name="email" />
</form>
<iframe src="https://go.pardot.com/l/483920/2026-02-03/xk2m"></iframe>
<div id="newsletter"></div>
<script src="https://js.hsforms.net/forms/embed/v2.js"></script>
<script>
  hbspt.forms.create({ portalId: "1234567", formId: "enquiry", target: "#newsletter" });
</script>
```

Recognition returns:

<!-- prettier-ignore -->
```json title=Booking page sightings
{
  "sightings": [
    {
      "provider": "salesforce-web-to-lead",
      "kind": "form",
      "position": 1,
      "action": "https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8",
      "hiddenFields": [
        "oid",
        "utm_source"
      ]
    },
    {
      "provider": "pardot",
      "kind": "iframe",
      "position": 2,
      "src": "https://go.pardot.com/l/483920/2026-02-03/xk2m",
      "hiddenFields": []
    },
    {
      "provider": "hubspot",
      "kind": "embed-script",
      "position": 3,
      "src": "https://js.hsforms.net/forms/embed/v2.js",
      "hiddenFields": []
    },
    {
      "provider": "hubspot",
      "kind": "embed-script",
      "position": 4,
      "hiddenFields": []
    }
  ],
  "notes": [
    "forms may be added by JavaScript"
  ]
}
```

The test `packages/core/src/forms/__tests__/forms-docs.test.ts` builds the page above and asserts this output.

## Running the checks

The checks read what recognition returns, one finding for each form for each check. Every finding names the provider by the label in the table above. Here they are on the booking page of Harbour Physio, an invented three-room clinic whose agency has put three form services on one page:

<!-- fixture: form-checks -->

```sh title=Terminal
$ npx gaugeline harbour-physio.example
```

```text title=Output
✗ Leads from this form arrive without where they came from
    HubSpot form posting to https://forms.hubspot.com/uploads/form/v2/1234567/newsletter: its tracking code is not on the page.
! Tracking starts after the form loads
    Pardot (Marketing Cloud Account Engagement) iframe https://go.pardot.com/l/100001/2026-02-03/xk2m: its tracking code is loaded by a window load handler, so it starts after the iframed form has loaded. Load the tracking script in the head, before the form.
! A form has nowhere to put campaign details
    Salesforce Web-to-Lead form posting to https://webto.salesforce.com/servlet/servlet.WebToLead has no utm_*, gclid or lead source field; hidden fields found: oid, retURL.
! A form has nowhere to put campaign details
    HubSpot form posting to https://forms.hubspot.com/uploads/form/v2/1234567/newsletter has no utm_*, gclid or lead source field; hidden fields found: none.
! Some buttons open an email instead of a form
    Opens an email instead of a form: "Talk to a physio" (mailto:reception@harbour-physio.example).
· Several form services on one page
    Forms from 3 services are on this page: Salesforce Web-to-Lead, Pardot (Marketing Cloud Account Engagement) and HubSpot.
? crm-no-campaign-fields could not be checked: could not see inside the embedded form: the Pardot (Marketing Cloud Account Engagement) iframe https://go.pardot.com/l/100001/2026-02-03/xk2m is another document (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

6 to look at, 1 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by `pnpm docs:examples` in CI.

### What each check looks at

- **`crm-no-tracking`:** a Pardot, HubSpot or Marketo form (or iframe) is in the HTML and the same service's tracking code is not anywhere on the page. The clinic's HubSpot newsletter form has none. Web-to-Lead, Formstack and Typeform have no tracking script of their own in the table above, so this check skips them rather than guess.
- **`crm-late-tracking`:** the tracking code comes after the form in the HTML, or an inline loader starts it from a window load handler while the form is an iframe. An iframe loads before that handler runs, so the first visit can already be over. The clinic's Pardot snippet is the standard one, which waits for the window load, and the form is an iframe. Fix: load the tracking script in the head, before the form. Gaugeline compares positions in the HTML and measures no timing, because it does not run the page.
- **`crm-insecure`:** an `http://` address in a form action, a recognized iframe, a form's embed script or a tracking script, on an `https://` page. Browsers may block it, and what people type isn't encrypted. A page served over plain http is not flagged, and neither is the `http://` branch inside Pardot's own snippet, which is only used on pages that are not https. The fixture above is served over http, so this check is shown below instead.
- **`crm-no-campaign-fields`:** a form posting to Pardot, Web-to-Lead, HubSpot or Marketo has no hidden input named `utm_*`, `gclid` or a lead source (`lead_source`, `LeadSource`), nor one of the service's own mapped fields (`campaign_id`, `Campaign_ID`, `hs_context`, `leadSource`). Names are matched without regard to case, and a visible input named `utm_source` does not count: only a hidden field is filled in from the address. When the fields are named differently (`source_campaign`), the finding still fires and lists the hidden fields it found, so you can see whether yours is mapped.
- **`forms-many-providers`:** more than one of the six services on one page, listed in the order they appear. Several tracking codes, consent notices and follow-up routines to look after.
- **`mailto-cta`:** a link that starts `mailto:`, whose words are a contact call to action ("Talk to a physio", "Get a quote", "Email us"). The enquiry lands in one person's inbox and skips the CRM. One finding for the page, listing the buttons. A link whose text is an address (`hello@clinic.example`) is a published contact and is left alone. Gaugeline cannot see whether a link is styled as a button, so it goes by the words.

### Example: a coach's site over https

Tideline Coaching is a one-person business on a Next.js site, with an enquiry form its Salesforce admin pasted in years ago. The site is https, but the form still posts to the old http address:

```html title=Enquiry form
<form action="http://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8" method="POST">
  <input type="hidden" name="oid" value="00Dxx0000000000" />
  <input name="email" />
</form>
```

On `https://tideline-coaching.example/enquire/` the checks return:

```text title=Enquiry form findings
crm-insecure: Salesforce Web-to-Lead form action http://webto.salesforce.com/servlet/servlet.WebToLead is plain http on an https page.
crm-no-campaign-fields: Salesforce Web-to-Lead form posting to http://webto.salesforce.com/servlet/servlet.WebToLead has no utm_*, gclid or lead source field; hidden fields found: oid.
```

The address is shown without its query. The test `packages/core/src/forms/__tests__/forms-docs.test.ts` builds the form above and asserts these lines.

## What it cannot see

- **A form drawn by JavaScript.** When a provider's embed script is on the page and its form is not in the HTML, the checks that needed the form say "not visible without running JavaScript" under could not check. They never report it as missing tracking.
- **The inside of an iframe.** An iframe is another document, and Gaugeline sends no request to a form provider. For `crm-no-campaign-fields` it says "could not see inside the embedded form" and leaves the form unjudged. That is a weaker answer for iframed Pardot forms, which are common, and it is the honest one: a pass or a fail would need the form's own page.
- **Tracking code moved at run time.** A tag manager can add or move a tracking script after the page loads. Gaugeline reads the HTML as sent, so it sees where the script is written, not where it ends up.
- **Whether leads arrived blank.** That needs the CRM itself.

::: info
Reading Pardot or Salesforce directly, to count how many recent leads arrived with a blank source, needs a read-only login and is on the roadmap.
:::
