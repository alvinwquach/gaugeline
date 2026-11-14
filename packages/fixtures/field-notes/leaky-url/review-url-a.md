- #menu-link-404 The link to https://menu.example.test/drinks.pdf returns not found.
  fail: <a href="/menu.pdf">Menu</a> where /menu.pdf is not served
  pass: <a href="/menu.pdf">Menu</a> where /menu.pdf is served
