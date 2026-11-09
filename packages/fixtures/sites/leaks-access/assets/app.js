// An invented bundle for Gaugeline's leaks and access fixture. The keys are filled in by the
// fixture server at serve time ({{planted:...}}) and are not real.
(function () {
  "use strict";
  var booking = { publishableKey: "{{planted:stripe-publishable}}", table: "/book" };
  // Two server-side secrets shipped to the browser, in one file.
  var STRIPE_SECRET_KEY = "{{planted:stripe-secret}}";
  var STRIPE_RESTRICTED_KEY = "{{planted:stripe-restricted}}";
  window.mothLantern = { booking: booking, ready: STRIPE_SECRET_KEY && STRIPE_RESTRICTED_KEY };
})();
