# WordPress: what the client published, against what the page shows

WordPress has no read-only key. Published posts and pages need no key at all, because the REST API lists them to any visitor. A key is asked for only to see drafts and who has access, and the narrowest one WordPress offers is an [application password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) on a dedicated user with the lowest role that does the job. An application password acts with the role of its user, so it is `scoped`, not `read-only`: a Contributor's password could write a draft, and Gaugeline never asks it to.

Read [Content systems](index.md) first for what every adapter does and never does. This page is what is specific to WordPress.

## The endpoints Gaugeline uses

Every request is a `GET` through the fetcher, which refuses private, loopback and metadata addresses unless `--allow-private` is set. Nothing is submitted, no login form is touched, `xmlrpc.php` is never called, and no path that is not a documented REST route is asked for. `<site>` is `WORDPRESS_URL`, so a WordPress installed in a folder works.

| Request                                                                          | Key                                 | What it is for                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET <site>/wp-json/wp/v2/types`                                                 | none                                | The content types the site lists (post, page, and any custom type) and the path each is read at                                                                                                                        |
| `GET <site>/wp-json/wp/v2/<type>?status=publish&per_page=1&_fields=id`           | none                                | How many published items a type has, from the `X-WP-Total` header, so no item is read to count it                                                                                                                      |
| `GET <site>/wp-json/wp/v2/<type>?status=publish&per_page=100&page=N&_fields=...` | none                                | Published items as fingerprints: only the fields named, in id order, a page at a time. `status=publish` is asked for and checked on every item, so a plugin that leaks drafts to visitors does not make them published |
| `GET <site>/wp-json/wp/v2/posts` and `pages` with `status=draft,pending,...`     | application password                | Whether the key can see unpublished work: a count, never a draft                                                                                                                                                       |
| `GET <site>/wp-json/wp/v2/users?context=edit&_fields=id,email,roles`             | application password, Administrator | Who has access, as a masked address and a role (the handoff report reads the same list with more detail)                                                                                                               |
| `GET <site>/wp-json/wp/v2/plugins` and `themes?status=active`                    | application password, Administrator | Installed plugin and theme versions, for `gaugeline advisory` only                                                                                                                                                     |
| `GET https://api.wordpress.org/core/version-check/1.7/`                          | none                                | The current WordPress release, for `--wordpress`                                                                                                                                                                       |
| `GET https://api.wordpress.org/plugins/info/1.2/` (and `themes/info/1.2/`)       | none                                | The current version of a plugin or theme the page's files name, for `--wordpress`                                                                                                                                      |
| `GET <site>/wp-json/wp/v2/users?per_page=100&_fields=id`                         | none                                | Whether the site lists its users to a visitor, for `--wordpress`: only the id is asked for                                                                                                                             |

These routes and parameters are the ones the WordPress REST API handbook describes. The handbook's pages ([posts](https://developer.wordpress.org/rest-api/reference/posts/), [users](https://developer.wordpress.org/rest-api/reference/users/), [authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)) could not be reached from the session that built this, so each detail was not compared with the current page in this release: check them before relying on one. The wordpress.org endpoints (`core/version-check/1.7/`, `plugins/info/1.2/`, `themes/info/1.2/`) are the ones WordPress itself uses and are not documented on a handbook page Gaugeline could cite; the tests use recorded stand-ins for their answers.

## Make the key

1. In the client's WordPress, add a user for Gaugeline (Users, Add New) with the lowest role that does what you need:

   | You want                                   | Role                                                   |
   | ------------------------------------------ | ------------------------------------------------------ |
   | Published content, counts and fingerprints | No user and no key at all                              |
   | Whether drafts exist                       | Contributor (sees its own) or Editor (sees everyone's) |
   | Who has access, or installed plugins       | Administrator, so think twice: see below               |

2. Open that user's profile, under Application Passwords give it a name such as "Gaugeline" and add it. WordPress shows the password once.
3. Set it in the environment, never in a file you commit:

   ```sh
   export WORDPRESS_URL=https://copper-lantern.example
   export WORDPRESS_USER=gaugeline-reader
   export WORDPRESS_APP_PASSWORD="abcd efgh ijkl mnop qrst uvwx"
   ```

4. Revoke it from the same profile page when you hand the site over.

The key is sent in an `Authorization` header and only over https, and only for drafts and members: published content is read with no header at all, exactly as a visitor's browser could read it. It is blanked, with or without the spaces WordPress shows, from every message, finding and report. If the user is not allowed to read something, that part is "could not check" with the reason and the rest still runs.

Installed plugins and themes are listed by WordPress only to an Administrator, so reading them means handing Gaugeline a key that can do everything. It is optional: it is used by `gaugeline advisory` only, only when `gaugeline.adapters.json` names `wordpress`, only for an advisory about WordPress itself, a plugin or a theme (any other advisory never uses the key), and only when `WORDPRESS_URL` is the site being checked: the list of one site is never used for another. Without it the advisory answer uses what the page's files show.

## Example: a cocktail bar built with Elementor

The Copper Lantern is an invented cocktail bar. Its freelancer built the site on WordPress with Elementor, so the pages are Elementor's, and the owner posts news and a few events. Before the owner phones to ask why the new menu is not up, the freelancer wants to know which posts changed lately and whether any drafts are waiting.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "wordpress",
      "fingerprint": { "post": ["title", "excerpt"] }
    }
  ]
}
```

With the three variables above set, this is what the adapter reads over the bar's site (invented, with a draft post and a draft page) for posts changed since 1 October:

```json title=Output
{
  "types": [
    {
      "name": "event",
      "count": 2
    },
    {
      "name": "page",
      "count": 3
    },
    {
      "name": "post",
      "count": 3
    }
  ],
  "post fields": {
    "title": 3,
    "excerpt": 2,
    "subtitle": 0
  },
  "drafts reachable": true,
  "changed": [
    {
      "id": "11",
      "type": "post",
      "url": "/news/autumn-cocktails/",
      "slug": "autumn-cocktails",
      "publishedAt": "2026-11-01T08:00:00.000Z",
      "updatedAt": "2026-11-03T14:30:00.000Z",
      "fieldHashes": {
        "title": "7d7fc47c70d79df5",
        "excerpt": "4f3a96f8172e8469"
      }
    },
    {
      "id": "12",
      "type": "post",
      "url": "/news/happy-hour/",
      "slug": "happy-hour",
      "publishedAt": "2026-09-01T08:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z",
      "fieldHashes": {
        "title": "a0dcb3a07bdca831"
      }
    }
  ]
}
```

Read it the way the freelancer does. The happy hour post has an empty excerpt, so it has no hash for it (a field an item lacks, or leaves empty, is left out and never hashed as empty), and `subtitle` is on no post. A draft is waiting and none of its text appears. Media files, menus and the block editor's own types are not listed, because they are not pages a visitor reads. The `url` is the permalink's path; with a headless front end, `urls` in the settings (`{ "post": "/blog/{slug}" }`) says where the item really lives.

The pages are Elementor's. A page's `content` is the HTML Elementor rendered, so naming it in `fingerprint` hashes that markup: it changes when the page is edited, and also when Elementor itself is updated, so use `title` and `excerpt` to see what the owner changed and `content` only to know that something on the page did.

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `wordpress`                                                                                                                                                                     |
| `adapters[].fingerprint`        | Fields to hash, by type (`post`, `page`, a custom type): `title`, `excerpt`, `content`, `slug`, or a path such as `meta.subtitle` where the site exposes it. Up to 20 per type. |
| `adapters[].urls`               | Where an item lives, by type. Without it, the permalink's path is used.                                                                                                         |

## Two checks for WordPress sites: `--wordpress`

```sh
npx gaugeline copper-lantern.example --wordpress
```

`--wordpress` adds two checks to the page check. It is off by default, and `gaugeline run --all --wordpress` adds it to every site of a nightly run. They look at a site's public face and need no key:

- **`wp-outdated`** (medium) reads the WordPress version the page shows (the generator tag, or the version on the files under `wp-includes`) and the version of each plugin and theme in the `?ver=` on its files, and compares them with the current releases from the public wordpress.org API. A `?ver=` is a version only when it is a release number written with dots (`2.1.3`, `5.8`, `1.0.0-beta2`); a date, a hash or a timestamp is a cache-buster and is never read as one. The number is what the page declares, and no more: a `?ver=` on a file the plugin bundles from another project (a `vendor`, `lib` or `fonts` folder, or a file such as `font-awesome` or `swiper`) is that project's number and is ignored, and a version newer than the directory's current release is could-not-check, never "current". At most 15 plugins and 15 themes are looked up in a whole run, however many pages it checks; the rest are listed as could-not-check with their count. The same logic reads the versions for [`gaugeline advisory`](../guides/advisory.md).
- **`wp-users-exposed`** (medium) asks the site's REST API for its list of users the way a visitor's browser can, with no login, and reports when it answers with users. Only the id is asked for: no name or slug is sent back, and only how many were listed is kept.

Here is what they say about the Copper Lantern's site, against recorded stand-ins for wordpress.org's answers (the current version numbers are invented, so the numbers you see on a real run will differ):

```json title=Output
{
  "findings": [
    {
      "check": "wp-outdated",
      "severity": "medium",
      "evidence": "The page declares WordPress 6.2.1 (read from the generator tag); the current release in the wordpress.org API is 6.8.3."
    },
    {
      "check": "wp-outdated",
      "severity": "medium",
      "evidence": "The page declares the plugin elementor 3.19.0 (read from the ?ver= on its files on this page); the current release in the wordpress.org directory is 3.25.4."
    },
    {
      "check": "wp-outdated",
      "severity": "medium",
      "evidence": "The page declares the plugin easy-booking 2.1.3 (read from the ?ver= on its files on this page); the current release in the wordpress.org directory is 2.4.0."
    },
    {
      "check": "wp-users-exposed",
      "severity": "medium",
      "evidence": "GET /wp-json/wp/v2/users?per_page=100&_fields=id with no login listed 2 users. Only the count was read; no name or slug was asked for or kept."
    }
  ],
  "could not check": [
    "1 component is not in the wordpress.org directory (theme copper-child), so there is no public current version to compare with: a premium or custom plugin or theme is updated from its vendor."
  ]
}
```

The gallery plugin is on its current release, so it is not listed. The child theme is the freelancer's own and is not in the wordpress.org directory, so it is could-not-check, not a pass.

A site that hides its versions is never reported as up to date. With no generator tag and no versioned file under `wp-includes`, the finding is "this site runs WordPress, but the page shows no version ... that is not the same as up to date". A plugin whose files carry a date or a hash, or more than one version number, or none, is the same: it is listed as could-not-check with the reason. A premium plugin that wordpress.org does not list is updated from its vendor and is could-not-check too.

### Is the users check a probing check?

Rule 14 of how Gaugeline is built says a check that asks for non-public paths, or uses a site's keys against its own APIs, is a probing check: off unless `--owner-consent` is given. `wp-users-exposed` is not one, and this is the reasoning so you can disagree with it: `/wp-json/wp/v2/users` is a documented, public REST route that WordPress answers to any visitor by default; the request is one `GET` with no key and no payload, the same one a browser can make; no path is guessed; and only the id is asked for. It is still off unless you pass `--wordpress`. If you would rather it needed `--owner-consent` too, that is one line in the check and a test.

## What cannot be checked, and why

| Part                                                  | Could not check when                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Anything, from the REST API                           | It is turned off or blocked: a 404 from `/wp-json/`, or a security plugin refusing visitors. The reason says which. |
| Drafts                                                | No key is set, the key is wrong, or the user's role may not list them                                               |
| Who has access, installed plugins                     | The user is not an Administrator                                                                                    |
| A custom type served by a plugin's own namespace      | It is not on `wp/v2`: it is left out, not guessed                                                                   |
| More than 2,000 published items of one type, by field | Counting a field means reading every item once, so past that it says it cannot, rather than count some              |
| Versions, for `--wordpress`                           | The site hides them, or their files carry a cache-buster                                                            |

Nothing is ever read from the admin screens, and the REST API's answer is never taken for more than it says: an empty list is not "all fine" when the request failed.

A site that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it read and says it is partial. Details are on the [Content systems](index.md) page.
