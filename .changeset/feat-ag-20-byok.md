---
"gaugeline": minor
---

New `gaugeline llm`: checks your model setup with your own key. It reads `gaugeline.llm.json` (a provider, a model for each tier and the name of the variable that holds your key) and says whether that variable is set. It sends nothing, never shows the key, and refuses a file that holds a key or a host.
