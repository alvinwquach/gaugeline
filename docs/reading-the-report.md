# Reading the report

Three levels, sorted by urgency.

| Level          | Means                                          | Example                                                        |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| Fix this first | Costs visitors, rankings or security right now | A leaked key, a canonical pointing elsewhere                   |
| Fix soon       | Weakens the site, but nothing is broken yet    | Missing sitemap, email-only contact buttons                    |
| Worth knowing  | Good to tidy, rarely urgent                    | Links through redirects, a public dataset with nothing private |

Below the findings, “What looked right” lists the checks that passed, so a clean report still shows what was verified.

### How the checks are weighted

<!-- chart: severity -->

_Red items cost you visitors, sales or security today. Amber weakens the site. Grey is tidy-up._

## Sharing it

`gaugeline-report.html` is a single file with no external dependencies. Email it, attach it to a ticket, or send it to a client.

## In this version

What the code in this repository does today. The sections above describe the product as published
on the site.

Every run that isn't `--json` writes `gaugeline-report.html` in the folder you run it from, and
prints `Report written to ./gaugeline-report.html` on stderr. It opens in your browser when you run
Gaugeline yourself at a terminal; it is never opened with `--no-open`, when `CI` is set, or when the
output is piped. In a folder Gaugeline can't write to, the run still finishes and prints its
results, with one line on stderr saying the report wasn't written.

The file is one page with its styles inline: no scripts, no fonts, no images, nothing requested from
anywhere, so it reads the same attached to an email. It holds:

- the counts for each level;
- each finding, grouped by level, with why it matters, how to fix it, the technical line and the
  check id;
- "What looked right": every check that passed, by its plain-English title, grouped by area in the
  same order as the findings, so a clean report still shows what was verified. A check that could
  not read something, or failed to run, is never listed there;
- what could not be checked (a refused page or sample) and any check that failed to run;
- how much was sampled, one line per kind: "30 of 112 links checked", or "all 14 links checked"
  when nothing was left out. Kinds with nothing found are left out; a page with nothing to sample
  says so. The terminal's closing line names only the kinds that were cut short ("Checked 30 of 112
  links, 20 of 46 images.") and `--json` carries every kind, zeros included, under `sampled`.

Every value from the site (a page title, an address, evidence) is escaped before it goes into the
file, so a page that puts markup in its title can't put markup in your report.
