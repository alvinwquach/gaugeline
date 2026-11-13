# renderer-clicks

An invented bakery (Quillfeather Bakery) with a tracking plan (`gaugeline.events.json`), for the click observer's end-to-end test (render-02). Nothing here is a real business. Each link does one thing the observer must handle:

| Link                 | What it does                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Menu                 | Nothing: it reports no event. It has `tabindex="1"`, so the keyboard reaches it first                      |
| Shop                 | Pushes `menu_click` to `dataLayer`, then navigates to `/shop.html` (the observer reloads the page)        |
| Visit                | Reports through `gtag('event', ...)`                                                                        |
| Jobs                 | Reports only on a wide screen                                                                               |
| Hours                | Hidden under 600 px, reports when clicked                                                                   |
| Partner              | A link to another site that the plan reads as part of the nav region: never clicked                        |
| Book                 | Tries to send `book_click` to analytics by a beacon (a POST): blocked, and its event read from the request            |
| Deal                 | A link to another site that the plan names by selector: clicked, its navigation cancelled                  |
| Order (a button)     | Listed by the plan, but it is a button: never clicked                                                      |
| In a form            | A link inside a form: never clicked                                                                        |

`partner.example` and `www.google-analytics.com` are never answered: the tests assert nothing is asked of them.
