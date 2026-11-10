// An invented checkout script for Gaugeline's Stripe test-mode fixture. The key is filled in by the
// fixture server at serve time ({{planted:...}}) and is not real.
(function () {
  "use strict";
  var config = { publishableKey: "{{planted:stripe-publishable-test-shop}}", price: "tamal-box" };
  document.addEventListener("click", function (event) {
    if (event.target && event.target.id === "buy") window.location.assign("/checkout?p=" + config.price);
  });
})();
