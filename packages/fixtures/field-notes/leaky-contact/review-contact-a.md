- #quote-form-no-consent The form mails chef@kitchen.example with no word about it.
  fail: <form action="/send"><input name="email"></form>
  pass: <form action="/send"><input name="email"><p>Used only to reply.</p></form>
