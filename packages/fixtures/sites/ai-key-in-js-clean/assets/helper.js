// The fixed booking helper: it asks the studio's own server route, which holds the key.
(function () {
  "use strict";
  function ask(question) {
    return fetch("/api/helper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question }),
    });
  }
  window.studioHelper = { ask: ask };
})();
