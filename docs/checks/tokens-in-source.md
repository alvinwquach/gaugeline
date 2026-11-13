# Tokens and webhook addresses in your source

A site built on Next.js and Sanity usually holds two kinds of secret that a visitor must never see: the token that reads (or writes) the content, and the address of the Slack channel, Zapier flow or kitchen printer that a form tells about a new booking. A freelancer's repository for a pub, a clinic or a shop tends to get both of them wrong the same way: the token ends up in code the browser downloads, and the address is pasted into a file.

These two checks read the repository, not the live site.

| Check                      | Finds                                                                                                   | Severity       |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | -------------- |
| `cms-token-in-client-code` | A content-system token in a `NEXT_PUBLIC_` variable, or in a module that a client component imports     | Fix this first |
| `webhook-url-hardcoded`    | The full address of a Slack, Discord, Zapier, Make, Teams, IFTTT, n8n, Pipedream or Google Chat webhook | Fix this first |

They only look. They read the files of a folder you name, through the static pack's reader: it never follows a link out of the folder, skips `node_modules` and `.git`, refuses `.env` files and anything that looks like a key, and caps what it reads. A check makes no request and runs no code. A finding names a file and a line, never the value it found: a token or a webhook address is not printed in the terminal, in JSON, in SARIF or in the report.

**A note on sources.** Documentation checked on: 2026-11-13. The Next.js documentation site could not be reached when this page was written (the build session's network policy refused it), so the pages below were read as the official Markdown sources in the Next.js repository at the `v16.4.1` tag [docs]: [Environment Variables](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/environment-variables.mdx) (lines 156 to 158: a variable without the `NEXT_PUBLIC_` prefix is only available in Node.js, and a `NEXT_PUBLIC_` value is inlined into the JavaScript bundle at build time) and [Data Security](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/data-security.mdx) (lines 243 to 255: mark a module with `import 'server-only'` to keep it out of client code). Everything else is **uncited**: that a webhook address works as a password for whoever holds it, the list of services and the shape of their addresses, and the idea that a read token shows unpublished drafts. Grounded Code was not connected.

## Example: a pub's menu and private-dining form

Quayside Taproom is an invented pub. A freelancer built its site with Next.js and Sanity: a menu that shows draught and cans, a draft preview for the owner, and a private-dining enquiry form that posts to the kitchen's chat channel. The folder has these parts that matter:

```text title=The folder
lib/sanity.ts                 reads SANITY_API_READ_TOKEN to make the content client
lib/preview.ts                exports process.env.NEXT_PUBLIC_SANITY_WRITE_TOKEN
components/MenuFilter.tsx     starts with "use client" and imports ../lib/sanity
app/enquiry/actions.ts        a server action with the kitchen channel's address in a constant
```

### A token a visitor's browser can reach

```json title="Findings: cms-token-in-client-code"
[
  {
    "checkId": "cms-token-in-client-code",
    "severity": "high",
    "title": "A content-system token is in code that is sent to the browser",
    "evidence": "lib/preview.ts: reads NEXT_PUBLIC_SANITY_WRITE_TOKEN. Next puts the value of a NEXT_PUBLIC_ variable into the JavaScript every visitor downloads.",
    "url": "source:./quayside-site",
    "source": {
      "file": "lib/preview.ts",
      "line": 1
    }
  },
  {
    "checkId": "cms-token-in-client-code",
    "severity": "high",
    "title": "A content-system token is in code that is sent to the browser",
    "evidence": "lib/sanity.ts: reads SANITY_API_READ_TOKEN, and components/MenuFilter.tsx (a client component) imports it, so it is built for the browser.",
    "url": "source:./quayside-site",
    "source": {
      "file": "lib/sanity.ts",
      "line": 4
    }
  }
]
```

Two different problems, one finding each. The first is certain: Next copies the value of a `NEXT_PUBLIC_` variable into the JavaScript every visitor downloads, so the write token is readable from the page. The second is the cause of the first one next time: `lib/sanity.ts` is imported by a client component, so it is built for the browser too, where a variable with no `NEXT_PUBLIC_` prefix is not available. The quick fix people reach for is to add the prefix.

**To fix it.** Keep the token in a variable with no `NEXT_PUBLIC_`, read it in a server module only, and put `import "server-only"` at the top of that module: importing it from a client component then fails the build instead of leaking. Fetch the menu on the server and pass it to `MenuFilter` as props. If a token was ever published, make a new one in Sanity's API settings and delete the old.

### A webhook address in the source

```json title="Findings: webhook-url-hardcoded"
[
  {
    "checkId": "webhook-url-hardcoded",
    "severity": "high",
    "title": "A webhook URL is written in the source code",
    "evidence": "app/enquiry/actions.ts: a webhook address is written in the source.",
    "url": "source:./quayside-site",
    "source": {
      "file": "app/enquiry/actions.ts",
      "line": 4
    }
  }
]
```

The finding says the file, the line and the kind of service. It does not print the address, because the part of an address that matters is the secret. **To fix it**, create a new webhook at the service (the old one is exposed), put the address in an environment variable on the server, such as `KITCHEN_WEBHOOK_URL`, and read it where the form sends the message. Then delete the old webhook.

## What each check looks at

- **`cms-token-in-client-code`.** A variable name with a content system's name (Sanity, Contentful, Storyblok, DatoCMS, Prismic, Contentstack, Hygraph, Directus, Strapi, Payload, Kontent) that ends in `TOKEN`, `SECRET` or `KEY`. `NEXT_PUBLIC_` on such a name is always a finding. Without it, the module that reads it is a finding when it has no `import "server-only"` and a file that starts with `"use client"` imports it, directly or through other files (relative paths and the `@/` and `~/` shortcuts; `import type` is ignored). Test and story files are not read.
- **`webhook-url-hardcoded`.** An `https` address in a code file or a `.github/workflows` file whose host and path match an incoming-webhook service, or whose path has `/webhook` or `/hooks` followed by a long segment of letters and digits. A placeholder (`XXXXXXXX`), an address built with a `${}` in its path and an address in a comment are not findings.

## What it does not cover

- It does not run your build. A client import that Next would only see after bundling (a dynamic `import()`, a path alias other than `@/` and `~/`, the Pages Router, where a page file is both server and client code) is not followed.
- `cms-token-in-client-code` does not say whether a published read is made with the token. Source text does not settle that; check the client's `useCdn` and `token` settings by hand.
- It does not look at a value. A token written as a literal in a file is not what these checks find (see `secret-in-js` for a token in a script the live site serves).
- `webhook-url-hardcoded` knows the services listed above and one generic shape. A webhook at a service not on the list, with a short address, is not found.

## When it cannot check

If the folder holds no source file, or a source file was left out (too large, not readable, a link), the checks say they could not check, with that reason. They never say the folder is fine when part of it was not read, and a folder with more files than Gaugeline reads never passes either.

[Every check, with what it catches and how to fix it](/docs/checks)
