# Chat and AI widgets on your pages

A live-chat bubble, a "help me choose" assistant or a booking bot is a script from another company that the
visitor's browser loads from your page. What a visitor types into it goes to that company. Many small sites
have one nobody remembers adding: a trial left running, a plugin's default, an assistant a salesperson
switched on. `ai-widget-inventory` lists the chat and AI widgets a page loads and flags the ones you have not
said you want.

It reads the page only and asks for nothing else, so it needs no consent flag.

## Say which ones you allow

Put the widgets you chose in `gaugeline.ai.json`, in the folder you run Gaugeline from. The file also holds
`aiCrawlers` (see [How AI agents read your site](agent-readiness.md)); each key is optional.

```json title=gaugeline.ai.json
{ "aiWidgets": { "allowed": ["intercom", "chat.example.com"] } }
```

- An entry is a vendor name from the list below, in any case, or a host. A host allows the widget's own host
  and anything under it: `intercom.io` allows `widget.intercom.io`.
- An empty list (`"allowed": []`) says no widget is allowed.
- With no `aiWidgets` entry at all, nothing is marked as allowed, and the check lists what it found as one
  low finding so you can write the list from it.
- Nothing in the file is a key.

## An example: a physiotherapy clinic

Harbour Lane Physio is an invented clinic. Its page loads an Intercom chat and Chatbase, an AI assistant. Its
owner allowed Intercom only.

<!-- fixture: ai-widgets -->

```sh title=Terminal
$ npx gaugeline harbour-lane-physio.example
```

```text title=Output
! A chat or AI widget loads on your page that you have not listed
    Chatbase (AI assistant, www.chatbase.co) loads on / and is not in the aiWidgets list in gaugeline.ai.json
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, none to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The finding names each widget, whether it
is a chat or an AI assistant, and the host it loads from. It does not say whether a widget is a good idea: that
is for you and the clinic to decide.

## What it reads

- Script addresses and iframe addresses on the page, and inline scripts (the first 16,384 characters of
  each), matched against a fixed table of vendors: Ada, Botpress, Botsonic, Chatbase, Chatra, Crisp, CustomGPT,
  Drift, ElevenLabs agent, Freshchat, Gorgias chat, HubSpot chat, Intercom, Kommunicate, Landbot, LiveChat,
  ManyChat, Olark, OpenAI ChatKit, Smartsupp, Tawk.to, Tidio, Voiceflow and Zendesk widget.
- A host matches itself and its subdomains, never a look-alike that only ends with the same letters. A
  page that only mentions a vendor in its text or a comment is not a sighting.
- "AI assistant" is shown for a vendor whose product is a model-driven assistant. A chat vendor that has added
  an AI feature is shown as "chat": a page does not show which feature a site turned on.

What it does not see: a widget a script adds after the page loads, a widget loaded by a tag manager container,
and a widget served from the site's own host. The vendor hosts and snippets are from memory, not from the
vendors' pages, which could not be reached when the check was written: the check's technical line in the
[checks reference](/docs/checks) says so.

## If you find one

1. Find who added it: a plugin, the tag manager, a theme setting, a script pasted into the template.
2. Remove the ones you do not want.
3. Put the ones you do want in `aiWidgets.allowed`, and tell the business owner that what visitors type goes to
   that company. If the widget is an AI assistant, decide with the business what the page should tell visitors about it.
