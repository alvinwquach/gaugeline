# ai-endpoints

An invented tea room (Cedar Row Tea Room) with a menu helper that talks to a model, for `ai-endpoint-open` (AI-12), a
probing check. Nothing here is a real business.

- `gaugeline.ai.json` lists three routes to ask (`modelEndpoints`); `gaugeline.consent.json` is the invented owner's
  consent to the probing checks.
- `/v1/models` lists its models to anyone: the finding (high).
- `/api/chat` answers 401 with the provider's own error text, including a masked key fragment: the finding (medium).
- `/api/assist` answers 405 (it wants a POST, which Gaugeline never sends): closed.

The passing copy is `ai-endpoints-closed`: the same three routes answer 401, 405 and 403 with plain messages.
