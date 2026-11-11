---
"gaugeline": minor
---

WordPress: content checks for sites built on WordPress. The WordPress adapter reads posts, pages and custom types through the REST API with no key (an application password on a dedicated low-role user only for drafts and members), and `--wordpress` adds two checks: `wp-outdated` compares the versions a page shows with the current WordPress, plugin and theme releases, and `wp-users-exposed` reports a REST API that lists its users to anyone. `gaugeline advisory` uses the adapter's list of installed plugins when you have set one up.
