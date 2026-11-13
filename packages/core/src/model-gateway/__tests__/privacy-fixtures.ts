/**
 * Invented values for the privacy tests, every one built from pieces so no key-looking, card-looking or
 * address-looking literal sits in the repository (and a secret scanner has nothing to find). The addresses
 * use reserved names, the phone number is in the range set aside for fiction, and the card and IBAN are the
 * published test values that belong to no one.
 */
import { buildModelPayload, type ModelInput, type RedactionKind } from "../privacy.js";

export const EMAIL = ["baker", "example.test"].join("@");
export const PHONE = "+44 20 7946 0958";
export const CARD = ["4111", "1111", "1111", "1111"].join(" ");
export const CARD_BARE = CARD.replaceAll(" ", "");
/** Sixteen digits that fail the card checksum: an order number, not a card. */
export const NOT_A_CARD = ["1111", "1111", "1111", "1112"].join(" ");
export const IBAN = ["GB82", "WEST", "1234", "5698", "7654", "32"].join(" ");
export const STRIPE_KEY = ["sk", "live", "q".repeat(24)].join("_");
export const GITHUB_TOKEN = ["gh", "p_", "a1B2".repeat(9)].join("");
export const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJkZW1vIn0", "c2lnbmF0dXJlLWRlbW8"].join(".");
export const BEARER = ["Bearer", "demo-token-value-1234567890"].join(" ");
export const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "ZGVtbyBwcml2YXRlIGtleSBib2R5IHRoYXQgYmVsb25ncyB0byBub2JvZHk=",
  "-----END PRIVATE KEY-----",
].join("\n");
export const URL_WITH_LOGIN = ["https://", "baker", ":", "hunter2hunter2", "@intranet/menu"].join(
  "",
);
export const PASSWORD_FIELD = '{"password": "correct-horse-battery"}';
export const ZWSP = String.fromCodePoint(0x200b);

/**
 * One fixture per redaction kind: text that holds a value of the kind; `value`, which must not survive the
 * gate; and `survives`, which does survive when only that kind's rule is taken out (so the fixture proves the
 * rule is the one doing the work, not another rule that happens to catch it too).
 */
export const KIND_FIXTURES: Record<
  RedactionKind,
  { text: string; value: string; survives: string }
> = {
  "hidden-characters": {
    // A key with a zero-width space inside it: only after the hidden characters are removed is it a key.
    text: `Key ${["sk", "live", `qqqqqqqq${ZWSP}qqqqqqqq${ZWSP}qqqqqqqq`].join("_")} in a script`,
    value: "qqqqqqqq",
    survives: "qqqqqqqq",
  },
  "private-key": {
    text: `Found ${PRIVATE_KEY} in a file`,
    value: "END PRIVATE KEY",
    survives: "END PRIVATE KEY",
  },
  "url-credentials": {
    text: `Opens ${URL_WITH_LOGIN} directly`,
    value: "hunter2hunter2",
    survives: "hunter2hunter2",
  },
  "credential-field": {
    text: `Config says ${PASSWORD_FIELD}`,
    value: "correct-horse-battery",
    survives: "correct-horse-battery",
  },
  secret: {
    text: `The page leaks ${STRIPE_KEY} in a script`,
    value: STRIPE_KEY,
    survives: STRIPE_KEY,
  },
  iban: { text: `Pay to ${IBAN} please`, value: "GB82", survives: "GB82 WEST" },
  card: { text: `The form shows ${CARD} in a label`, value: "4111", survives: "4111" },
  email: { text: `Mail ${EMAIL} for the menu`, value: EMAIL, survives: EMAIL },
  phone: { text: `Call ${PHONE} for the menu`, value: "7946", survives: "7946" },
};

/** A whole page, small enough to pass the size check, so it is the shape that is refused. */
export const WHOLE_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><title>Pop-up</title></head>',
  "<body><h1>Menu</h1><p>Opening hours</p></body></html>",
].join("\n");

/**
 * An input whose payload is exactly `chars` characters long, for the tests that count characters (budgets):
 * as many 300-character snippets as fit, and the rest made up in the task. Findings carry plain letters, so
 * nothing in the payload is escaped and the length is the one asked for.
 */
export function sizedInput(chars: number): ModelInput {
  const finding = (k: number) => ({
    id: `f-${k}`,
    checkId: "menu-link",
    title: "Menu link",
    snippet: "a".repeat(300),
  });
  const length = (task: string, n: number) => {
    const r = buildModelPayload({
      task,
      findings: Array.from({ length: n }, (_, k) => finding(k)),
    });
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r.payload.length;
  };
  let n = 0;
  while (n < 20 && length("Reword.", n + 1) <= chars) n += 1;
  const pad = chars - length("Reword.", n);
  if (pad < 0 || pad > 900) throw new Error("this size cannot be built from whole findings");
  return {
    task: `Reword.${"a".repeat(pad)}`,
    findings: Array.from({ length: n }, (_, k) => finding(k)),
  };
}
