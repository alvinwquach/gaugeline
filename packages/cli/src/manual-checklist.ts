/**
 * What only a person can do on cutover day, said at the end of `gaugeline snapshot` and
 * `gaugeline cutover`. A fixed list of lines in one place: nothing here is read from the site, and
 * nothing here is a check, so it never changes what a run finds, the exit code, or any file.
 */

/** Registrar data needs registrar access: said, never guessed. */
export const REGISTRATION_NOTE =
  "Domain registration expiry needs the registrar's records: not checked. Look it up at your registrar.";

const HEADER = "Do by hand (Gaugeline sends nothing):";

const MAIL_TEST =
  "Send a test email from outside to an address on the client's domain, and one from the client's mail to outside. Check that both arrive.";

/** The comparison reads differently before cutover (the snapshot is the record) and after it. */
const COMPARE = {
  snapshot:
    "Compare the SPF, DKIM and DMARC records in this snapshot with what the new mail host documents.",
  cutover:
    "Compare the SPF, DKIM and DMARC records now in DNS with the snapshot, and with what the new mail host documents.",
} as const;

/** The block printed once, after everything else, when the notes are not silenced by --quiet. */
export function manualChecklist(mode: keyof typeof COMPARE): string {
  const steps = [MAIL_TEST, COMPARE[mode], REGISTRATION_NOTE];
  return [HEADER, ...steps.map((s, i) => `  ${i + 1}. ${s}`)].join("\n");
}
