# ai-widgets

An invented physiotherapy clinic (Harbour Lane Physio) for `ai-widget-inventory` (AI-11). Nothing here is a real
business.

- `/` loads two chat widgets: Intercom, and Chatbase (an AI assistant).
- `gaugeline.ai.json` allows `intercom` only, so the check flags Chatbase.
- Run from a folder with no `gaugeline.ai.json`, the check lists both as a low finding instead.

The passing copy is `ai-widgets-clean`: the same page with no widget.
