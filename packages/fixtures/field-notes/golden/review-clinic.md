# Pre-launch pass, small clinic

- #menu-link-404 A footer link to a downloadable file returns not found after a redeploy.
- #noindex-left-on The launch site still tells search engines not to index it.
  fail: <meta name="robots" content="noindex">
  pass: <meta name="robots" content="index,follow">
- #cookie-banner-covers-cta The cookie banner covers the call-to-action on a phone.
  fail: <div class="banner" style="position:fixed;bottom:0;height:60vh">Cookies</div>
