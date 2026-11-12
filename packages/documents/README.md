# @gaugeline/documents

Reads the text of a PDF so Gaugeline can compare a printable menu or price list with the site. No dependencies: it uses `node:zlib` only.
Install it beside `gaugeline` (`npm install @gaugeline/documents`); without it the document checks say they could not check.

It reads the text layer only. A scanned PDF, an encrypted one, or one whose fonts carry no text mapping is reported as unreadable with the reason, never guessed at (no OCR).
Limits (a hostile file cannot run it out of memory or time): 200 pages, 4 MiB inflated per stream, 48 MiB inflated in all, 50,000 objects.
