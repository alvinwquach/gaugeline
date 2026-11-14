---
"gaugeline": patch
---

With `--renderer playwright`, a page that calls Gaugeline's own functions hundreds of thousands of times in a loop is now stopped after a thousand calls and reported as could not check, instead of using up the memory of the run.
