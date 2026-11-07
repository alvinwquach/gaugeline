# redirects

`redirect-list.csv`: an invented from/to list for the free redirect tool (X45), on the invented
Lantern Books site. Three planted problems, found in the browser before any request:

- `/old-gifts` is listed twice with different destinations (lines 5 and 6): duplicate.
- `/about-us` goes to `/old-about`, which line 7 redirects again (line 8): chain.
- `/press` redirects to itself (line 9): self.
