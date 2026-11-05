// An invented site bundle for Gaugeline's leaked-key fixture. The keys are filled in by the
// fixture server at serve time ({{planted:...}}) and are not real.
(function () {
  "use strict";
  var config = {
    publishableKey: "{{planted:stripe-publishable}}",
    cartUrl: "/cart",
  };
  // The mistake this fixture is about: a server-side secret shipped to the browser.
  var STRIPE_SECRET_KEY = "{{planted:stripe-secret}}";
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(function () {
    window.bramble = { config: config, hasKey: STRIPE_SECRET_KEY.length > 0 };
  });
})();
