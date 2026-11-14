// An invented booking helper for Gaugeline's AI key fixture. The key is filled in by the fixture server
// at serve time ({{planted:...}}) and is not real.
(function () {
  "use strict";
  // The mistake this fixture is about: a model key shipped to the browser.
  var OPENAI_API_KEY = "{{planted:ai-openai-project}}";
  function ask(question) {
    return fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-mini", messages: [{ role: "user", content: question }] }),
    });
  }
  window.studioHelper = Object.assign(window.studioHelper || {}, { ask: ask });
})();
