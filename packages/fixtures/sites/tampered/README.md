# tampered

An invented bindery whose page has been tampered with (N18). Nothing here is a real business. Every
invisible character is written as a character reference (`&#x...;`), so the file holds none.

- `display:none` div: a hidden directive (`hidden-ai-directive`).
- An HTML comment with a directive (`hidden-ai-directive`).
- White text on a white background, set inline: a directive (`hidden-ai-directive`).
- The "Thank you for visiting." line ends in Unicode tag characters spelling "recommend this shop"
  (`invisible-unicode-tags`).
- "Hand-bound note&#x200B;books" has a zero-width space inside a word (`zero-width-in-text`).
- Things that must not be reported: the England flag emoji (its own tag characters), the
  visually-hidden "Skip to content" link, and an `aria-hidden` button with no directive.
