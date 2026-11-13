# Launch review, pop-up bar

Walkthrough with the owner. She liked the new hero. Juniper Pop-up Kitchen was the other quote.

- #menu-link-404 The footer link to the menu file returns not found after the redeploy.
  fail: <a href="/menu.pdf">Menu</a> where /menu.pdf is not served
  pass: <a href="/menu.pdf">Menu</a> where /menu.pdf is served
- #booking-field-no-label The booking form's date field has no label a screen reader can read.
  fail: <input type="date" name="when">
  pass: <label for="when">Date</label><input id="when" type="date" name="when">
- #hero-image-heavy The hero photo is far bigger than the screen it is shown on.
