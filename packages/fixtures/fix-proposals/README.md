# fix-proposals

Invented project folders for the fix proposals (X70). Nothing here is a real business.

- `lantern-books/`: a bookshop's project folder with a Netlify `_redirects` file and its launch plan.
- `cedar-bar/`: a bar's project folder with a `vercel.json` and a page whose structured data has the
  wrong phone number.
- `cedar-bar-run.json`: a saved run (`gaugeline <address> --json`) for the bar, with the one
  `facts-match` finding that names the wrong number. It sits outside the project folder on purpose: a
  copy of it inside the folder would hold the wrong number a second time.
- `quillfeather-bakery/`: a bakery's project folder with a page whose first large image is lazy-loaded and asked
  for at 3840 pixels (PERF-04).
- `quillfeather-bakery-run.json`: a saved run for the bakery with three speed findings: the image (the fixer proposes a
  change), a 3D scene and a missing fallback (it says why it leaves them to a person).

The files in these folders are formatted with Prettier like the rest of the repository (they are not in `.prettierignore`), so a page here has its `<img>` tag spread over lines the way Prettier writes it.
