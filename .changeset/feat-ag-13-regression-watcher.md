---
---

(internal) A regression watcher that compares each run with the last by finding id and severity, counts only what got worse (a new finding or a higher severity), and returns a message only then. It sends nothing.
