# switches-bar

An invented bar for N11, for the 86 list. The kitchen marked two items as 86'd in the database, and
the site did not follow:

- `/menu` still lists "Smash Burger" (the database has "Smash burgers", with the plural and a
  different case) and "Fried pickles" (the same name).
- The Menu structured data on `/menu` still has "Smash burger".
- `/tonight` lists neither, and is the clean page of the pair.

Used by the docs test for docs/guides/switches-and-availability.md. Pages are plain files with
relative links; the canonical, sitemap and share-image addresses name `lantern.example`, which tests map to the files with an in-memory site.
