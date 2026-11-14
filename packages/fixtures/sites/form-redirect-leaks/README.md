# form-redirect-leaks

An invented physiotherapy clinic (Harbour Physio) for `form-redirect-leaks-details`. Nothing here is a real
business, person or form; the email address and phone number are made up, at a reserved `.example` host.

- The booking form's action carries an email address in its query string: a finding.
- The call-back form's hidden `retURL` field sends visitors to a thank-you address with a phone number in its
  query string: a finding.
- The newsletter form's `retURL` is a clean `/thanks` address: nothing.
- The last form has an action of `#` and submits through script: could-not-check, never a pass.
- No form is submitted and no thank-you address is requested: the check reads this page only.
