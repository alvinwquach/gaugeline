# clinic-trackers

An invented family clinic (Meadowlark Family Clinic) for the tracker checks (E-14). Nothing here is a real
business, patient, pixel or account: every id is made up.

- `/intake` has a patient intake form that sends to another site (intake.carelink-forms.example), a Meta
  pixel, Google Analytics 4 and Hotjar: `tracker-on-sensitive-page`, three findings.
- `/blog` is an article with no form and no tracker.
- `/` has Google Analytics 4 and no form: not a page the check counts.
- `/conditions/asthma` has no form and no tracker; with `"sensitivePaths": ["/conditions/*"]` it counts, and
  it has a LinkedIn Insight Tag.
