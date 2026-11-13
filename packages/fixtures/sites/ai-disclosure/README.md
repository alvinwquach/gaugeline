# ai-disclosure

An invented dental practice (Juniper Street Dental) with a question box whose script sends what a visitor types to a
model provider, for `ai-input-no-disclosure` (AI-13). Nothing here is a real business or person.

- `/` has a textarea and an inline script that calls `api.openai.com`; nothing on the page says an AI answers: the finding.
- Nothing is requested from the provider: the check reads the page only.

The passing copy is `ai-disclosure-told`: the same page, with a sentence saying an AI assistant answers.
