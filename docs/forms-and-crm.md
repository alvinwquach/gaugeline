# Forms and CRM tracking

Whether a lead can reach your CRM knowing where it came from.

Gaugeline recognizes Pardot (Marketing Cloud Account Engagement), Salesforce Web-to-Lead, HubSpot, Formstack, Marketo and Typeform on a page, and checks four things without any login.

<!-- diagram: leads (drawn on the landing page; not reproduced here) -->

- **If you own the site:** If this is wrong, you still get leads: you just can't tell which advert, email or search brought them.
- **If you run marketing:** This is the attribution gap that makes a working campaign look dead in reporting.
- **If you edit content:** If a form on a page you edit is flagged, send it to whoever set up the form.
- **If you build the site:** Checked from the rendered page: the tracking script, its load order, the form action, and the presence of hidden campaign fields.

## The four checks

| Check                               | Why                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| A form with no tracking on the page | The CRM can't connect the lead to the campaign that brought them.                    |
| Tracking that loads after the form  | Salesforce documents that this loses first-touch and UTM data.                       |
| An insecure form                    | Part of the form or its tracking loads over plain http.                              |
| No campaign fields                  | A form posting to a CRM with no `utm_*` or `gclid` inputs; every lead arrives blank. |

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

In this version recognition is in the library only. The four checks that use it are described above and arrive next, so no command prints these results yet.

::: info
Reading Pardot or Salesforce directly, to count how many recent leads arrived with a blank source, needs a read-only login and is on the roadmap.
:::
