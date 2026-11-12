/**
 * The pre-push hook rejects a commit whose message carries an attribution line: a Co-authored-by trailer,
 * a line that starts with "Generated with" (after any emoji or punctuation) or a Claude-Session line, in any letter case. Pure, so a test can cover it.
 */
const FORBIDDEN: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /^\s*co-authored-by\s*:/im, what: "a Co-authored-by line" },
  { re: /^[^\p{L}\p{N}]*generated\s+with\b/imu, what: 'a "Generated with" line' },
  { re: /^\s*claude-session\s*:/im, what: "a Claude-Session line" },
];

/** What is wrong with one commit message, in words a person can act on. Empty when it is fine. */
export function attributionProblems(message: string): string[] {
  return FORBIDDEN.filter(({ re }) => re.test(message)).map(
    ({ what }) => `the message has ${what}`,
  );
}
