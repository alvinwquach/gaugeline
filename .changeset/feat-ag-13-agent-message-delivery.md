---
---

(internal) The hosted worker can send two agent messages to a Slack channel that takes them: an alert when a night's run got worse than the one before, and a morning digest of the drafts waiting for a decision. Both go through the existing sender, to the channel's own address, and a quiet night or an empty inbox sends nothing.
