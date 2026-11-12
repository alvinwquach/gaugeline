# Joomla: content checks for sites built on Joomla

What a Joomla site's Web Services API says is published, against what the live site shows. Gaugeline only reads. Joomla has no token that can only read, so it asks for an API token of a dedicated user whose group can sign in to the API and can do nothing else.

## What this adapter reads, and the narrowest key

**The key first.** Joomla 4 and 5 have a REST API, the Web Services API (JSON:API format), under `/api/index.php/v1`. Its key is an **API token that belongs to one user and carries that user's rights**. Joomla has no read-only token type, so Gaugeline's key kind for Joomla is `scoped`, not `read-only`: the narrowest key is a token for a **dedicated user** in a **group of its own** that has the _Access API_ permission and **no** create, edit or delete permission on Content. With such a user a program can list articles and cannot change or delete anything, because every write route checks the user's rights. A token for a Super User can write: do not use one. Joomla's own list route does not check any right beyond signing in to the API, so the dedicated user sees what its view levels allow, **including unpublished articles at those levels**; that is why `drafts reachable` is a question this adapter answers. [docs]

The address and the token come from the environment, never from a file you commit:

```text
JOOMLA_URL=https://www.client.example
JOOMLA_TOKEN=<the API token of the dedicated user>
```

`JOOMLA_URL` is the Joomla site's own address: `https` only, no sign-in details, no query, and at most a folder (`https://www.client.example/cms`) because Joomla is often installed in one. The token goes in the `X-Joomla-Token` header and never in an address, it is sent only to that origin, it is dropped if the server redirects to another origin, and every message, finding and report has it blanked. A token with spaces or line breaks is refused before anything is sent. A freelancer's client for this page: a yoga studio, a clinic or a coach with a brochure site on Joomla. The example below is Larkspur Yoga Studio, invented.

**A note on sources.** Joomla's documentation sites (`docs.joomla.org`, `manual.joomla.org`) could not be reached when this page was written (the build session's network policy refused them). Documentation checked on: 2026-11-11, by reading Joomla's own source code, which is the Web Services API's definition, at the tags 5.4.0 and 4.4.0 of the official repository: [ArticlesController](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/api/components/com_content/src/Controller/ArticlesController.php) (the `filter[state]` and `list[ordering]` parameters), [ApiController](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/libraries/src/MVC/Controller/ApiController.php) (`page[limit]` and `page[offset]`, a default of 20 articles a page), [JsonApiView](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/libraries/src/MVC/View/JsonApiView.php) (the `meta.total-pages` count and the page links), [the Content web services plugin](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/plugins/webservices/content/src/Extension/Content.php) (the `v1/content/articles` routes, not public), [the API router](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/libraries/src/Router/ApiRouter.php) (a GET route is public only when a plugin makes it so), [the API application](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/libraries/src/Application/ApiApplication.php) (the `core.login.api` right and the `application/vnd.api+json` content type, 406 for any other), [the token authentication plugin](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/plugins/api-authentication/token/src/Extension/Token.php) (the `X-Joomla-Token` header and `Authorization: Bearer`) and [the article list model](https://raw.githubusercontent.com/joomla/joomla-cms/5.4.0/administrator/components/com_content/src/Model/ArticlesModel.php) (which articles a state filter and a user's view levels give). Every link below is the 5.4.0 file; for 4.4.0 only the article filters, the `page[limit]`/`page[offset]` handling, the default of 20 and the `meta.total-pages` count were read, and they are the same. [docs] What the source does not say is marked `uncited`: that Public is view level 1 on every site, and a maximum for `page[limit]`. Check this page against [the Joomla manual](https://manual.joomla.org/docs/general-concepts/webservices/) [docs] before relying on a detail; that page could not be read.

This page lists the routes read, how to make the user and the token, a worked example, what the two Joomla checks find, what could not be checked, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What it reads

Every request is a `GET` to your `JOOMLA_URL`, through the same fetcher as every other request, with `Accept: application/vnd.api+json` (Joomla answers 406 to any other). Nothing else is ever sent.

| Request                                                                                                                       | Token | What for                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/index.php/v1/content/articles?filter[state]=1&list[ordering]=a.id&list[direction]=ASC&page[limit]=N&page[offset]=M` | yes   | The Published articles: counts, fingerprints and field counts. `a.id` order keeps the windows stable.                                                                  |
| the same with `page[limit]=1`, then `page[limit]=2`, no `filter[state]`                                                       | yes   | The count of articles with no filter (Joomla lists published and unpublished ones), compared with the published count, for whether the token reaches unpublished work. |
| the same with `page[limit]=1`, and no token                                                                                   | none  | Only with `--owner-consent`: what a visitor is told. See [the two checks](#the-two-checks).                                                                            |
| one `GET` of each article's page on the live site                                                                             | none  | For the article-with-no-page check: the address the `urls` pattern makes.                                                                                              |

**The adapter reads one type: articles.** Joomla's API reports a _page count_ (`meta.total-pages`), not a total, so a count is a window of one article, checked with a window of two: the pages there must be half the count, rounded up. A server that clamps the window (an extension, a proxy) breaks that, and the count is could-not-check, never a wrong number.

Joomla's API gives **no address** for an article: the page's address depends on the site's menu and its URL settings. So an article's page address is the `urls` pattern for `articles` in `gaugeline.adapters.json`, such as `/studio/{slug}` (`{slug}` is the article's alias, `{id}` its id). With no pattern, no live page is asked and the check says so. The pattern must fit the whole site: if articles live under several menu items, a page that answers 404 at the pattern's address is a mismatch of the pattern, and the fix text says to check it first.

Lists are read a window at a time. The window moves by the number of articles that came back, never by the number asked for. Joomla moves a window that starts past the last full page back to the last page's start, so repeated articles are dropped and counted once. A list is complete only when every counted article was seen: an empty window before the count, a window with only articles already seen, a count that is not a number, a list that changed while it was read, more than 10,000 published articles and a list that needs more than 500 requests are all could-not-check, never a count of part of the list. When Joomla answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

Of the published articles, Gaugeline asks the live site only for those a visitor can open at the pattern's address. It **counts and leaves out**: an article at a view level other than Public (a visitor is sent to sign in), one whose start time has not come, one whose finish time has passed, and one in a single language (not _All_), whose address carries a language prefix the settings cannot say. The last is could-not-check by count; the first three are normal and are only counted (`left out of the list` below).

### What reaches your computer

Joomla's list sends each article's attributes, **including its title and its text** (the introduction and the rest), and a request cannot leave them out. Gaugeline keeps only the article's id, state, view level, language, alias, start, finish and update times, and the fields named in `fingerprint`, and only until they are counted or hashed. Nothing but the short hash is printed, logged or put in a finding or report. A field Joomla sends empty (`""`) is left out of the hashes, as a missing one is. With no `fingerprint` in the settings no field is kept.

## Make the user and the token

In the Joomla administrator (Joomla 4 or 5):

1. **Users, Groups, New.** Name it, for example, `Gaugeline read`, with the parent group `Registered`. In **System, Global Configuration, Permissions**, give the group **Access API** and nothing else. Check the group has no Create, Delete or Edit right on Content (Global Configuration or the Articles options).
2. **Users, Manage, New.** Make a user (for example `gaugeline`), assign only that group, and save.
3. Enable the plugins **API Authentication - Web Services Joomla Token** and **User - Joomla API Token**, and the web services plugins **Web Services - Content**, if they are not on. [docs]
4. Open the user, the **Joomla API Token** tab, tick **Enabled** and copy the token. Put it in `JOOMLA_TOKEN`.

`uncited`: the exact menu names are from the build's knowledge of Joomla's administrator, not the manual. The permission to look for is the one the source calls `core.login.api`, shown as _Access API_.

## Example: a yoga studio on Joomla

Larkspur Yoga Studio is an invented small studio. A freelancer built its site on Joomla 5: class pages, a teacher page and notices, all kept as articles under one menu item (`/studio`). The owner edits the site between classes and saves the autumn retreat as a draft long before she announces it. The freelancer wants to know, before the owner does, which published articles have no page, and whether the API is open to anyone when it was meant to be private.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a token.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "joomla",
      "fingerprint": { "articles": ["title", "metadesc"] },
      "urls": { "articles": "/studio/{slug}" }
    }
  ]
}
```

With `JOOMLA_URL` and `JOOMLA_TOKEN` in the environment, this is what the adapter reads over the studio's Joomla (invented: one article saved as a draft, and the API's list route needing a token):

```json title=Output
{
  "types": [
    {
      "name": "articles",
      "count": 7
    }
  ],
  "article fields": {
    "title": 7,
    "metadesc": 2,
    "subtitle": 0
  },
  "a type the adapter does not read": "The Joomla adapter reads articles only; \"categories\" is not read.",
  "drafts reachable": true,
  "left out of the list": {
    "notPublic": 1,
    "scheduled": 1,
    "expired": 1,
    "otherLanguage": 1
  },
  "published articles": [
    {
      "id": "1",
      "type": "articles",
      "url": "/studio/morning-flow",
      "slug": "morning-flow",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "title": "bf6cfe02935d0830",
        "metadesc": "0eb2f492ce8a2e14"
      }
    },
    {
      "id": "2",
      "type": "articles",
      "url": "/studio/evening-stretch",
      "slug": "evening-stretch",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "title": "b2034730d8a459ff"
      }
    },
    {
      "id": "4",
      "type": "articles",
      "url": "/studio/closed-last-friday",
      "slug": "closed-last-friday",
      "publishedAt": "2026-11-03T12:00:00.000Z",
      "updatedAt": "2026-11-03T12:00:00.000Z",
      "fieldHashes": {
        "title": "d116e7feb3f7ebe4",
        "metadesc": "bc3ce80942e28915"
      }
    }
  ]
}
```

`types` counts the articles Joomla calls Published, seven here: that includes one for Registered users, one that starts in March, one that ended in September and one in French. `article fields` says seven have a title and two have a description (the other five have none). A name no article has counts 0. `drafts reachable` is true because the token is shown more articles without the Published filter than with it: the autumn retreat is saved and not published. `left out of the list` says why only three of the seven are given to the page check, and no article is missing quietly. Nothing here is the studio's words, only counts, ids, aliases, dates and hashes.

## The two checks

These two checks run from one read of the Joomla site (`readJoomla`), not from a page, so they are listed in the [checks reference](/docs/checks) and not in a page run.

**`joomla-article-no-page`: A published Joomla article has no page on the live site.** For each article the API says is published for every visitor and that has an address, Gaugeline asks the live site for that page once. A final 404 or 410 is the finding, and it names the article's alias (or id) and the path, never its text. Any other answer that is not a 2xx is could-not-check for that page. With no pattern, an alias the pattern cannot use, articles in one language and pages past the run's budget of 300 are could-not-check, never skipped quietly. To fix one: check a menu item shows the article and is published with Public access, that the article's category is published, and, when every article fails, that the pattern matches the menu.

**`joomla-api-public`: The Joomla Web Services API answers visitors with no token.** This is a **probing** check: it asks a route a visitor is not meant to use when the API is private. **It is off unless you run with `--owner-consent` (or a `gaugeline.consent.json` entry), and you should run it only on sites you own or have permission to test.** It also runs only when you say the API is meant to be private, with `"expectPrivate": true` in the `joomla` entry of `gaugeline.adapters.json`. Setting `JOOMLA_TOKEN` does not say it: Joomla's own routes need a token, but an extension may make one public on purpose. Without `expectPrivate` the check is could-not-check ("no privacy expectation given"). It sends one `GET` of `/api/index.php/v1/content/articles?page[limit]=1` with no `X-Joomla-Token`, no cookie and nothing the fetcher adds per address. A 200 with a JSON:API list and a numeric `meta.total-pages` is the finding, and the evidence is that count, never an article. A 401 or 403 is a route that needs a token and a 404 is an API that is off or not at that address: neither is a finding. A 200 that is not the API's list (a site that answers every path with a page) and any other status are could-not-check. To fix it: switch off the web services plugins you do not use, or find the extension that registered the public route, and send the token from the server, never from the browser.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the administrator:

| Question                                                             | Answer here              | Why                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content other than articles (categories, modules, custom components) | not read                 | The adapter reads articles only. A name in the settings that is not `articles` is could-not-check by name.                                                                                     |
| An article's page address                                            | the settings' pattern    | The API gives none: it depends on the site's menu and URL settings.                                                                                                                            |
| Who has access to the site (`members`)                               | not offered              | The users route is never used.                                                                                                                                                                 |
| Whether a page shows the same words                                  | not decided here         | The adapter gives hashes; comparing them with the page is another check.                                                                                                                       |
| Articles in another language                                         | could-not-check by count | Their address carries a language prefix the settings cannot say.                                                                                                                               |
| Whether unpublished work is reachable when the counts match          | could-not-check          | No more articles unfiltered than filtered does not show nothing is unpublished: there may be none, or they may be at a view level the user cannot see. Only more articles unfiltered is a yes. |
| Archived and trashed articles                                        | not read                 | The Published filter and the default list leave them out.                                                                                                                                      |
| A page's view level other than Public                                | counted, not asked       | A visitor is sent to sign in, so no page is expected. `uncited`: view level 1 is Public on every install.                                                                                      |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `JOOMLA_URL` is not set or is not an `https` site address, or `JOOMLA_TOKEN` is not set or is not a token (nothing is asked);
- Joomla answers 401 (the token is wrong, disabled, or the user's group may not sign in to the API), 403 (the group lacks _Access API_) or 404 (the web services are off, or `JOOMLA_URL` is not the Joomla site);
- an answer is not the shape the API sends, an article has no usable id, state, view level or update time, or an article that is not published comes back from the Published filter;
- there are more than 10,000 published articles, a window is too big even at 10 articles, the list stops before its count, repeats itself, changes while it is read, or needs more than 500 requests, or the page counts for one and two articles a page do not agree.

## What is bounded

| Limit                               | Value  |
| ----------------------------------- | ------ |
| Articles asked for in one request   | 100    |
| Published articles read in one list | 10,000 |
| Requests spent on one list          | 500    |
| Live pages asked for in one run     | 300    |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `joomla`.                                                                                                                           |
| `adapters[].fingerprint`        | Fields to hash, under `articles`: an article's attribute names, such as `title`, `metadesc` or a custom field's name. Up to 20.     |
| `adapters[].expectPrivate`      | `true` says the Web Services API is meant to be private, which switches on `joomla-api-public` (still only with `--owner-consent`). |
| `adapters[].urls`               | Where the articles' pages live, under `articles`: a path or an https address. Only `{slug}` and `{id}` are filled in.               |

| Environment variable | What it is                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `JOOMLA_URL`         | The Joomla site's address (https, at most a folder). Not a key.                                                         |
| `JOOMLA_TOKEN`       | The API token of the dedicated user, sent in `X-Joomla-Token`. It does not say the API is private: use `expectPrivate`. |
