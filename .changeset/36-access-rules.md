---
"gaugeline": minor
---

Database access rules, tested from outside: with gaugeline.access.json, Gaugeline asks your Supabase project, as an anonymous visitor and as test users you set up, how many rows of each table they can read, and reports tables open to anyone and users who can read other people's rows. It reads counts and column names, never a row.
