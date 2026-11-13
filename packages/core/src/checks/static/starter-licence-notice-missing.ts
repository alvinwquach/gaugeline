import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { lineOf } from "./source-scan.js";

// [docs] SPDX license list, ISC and MIT texts - https://raw.githubusercontent.com/spdx/license-list-data/main/text/ISC.txt and https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt (read 2026-11-11). ISC: permission is granted "provided that the above copyright notice and this permission notice appear in all copies"; MIT: the notice "shall be included in all copies or substantial portions of the Software".
// [GC] no source found (uncited): that a project made from a starter is a copy in the licence's sense. The check never says code was copied; it says a notice is not in the folder, and what it saw that made the notice relevant.

const ID = "starter-licence-notice-missing";
/** The permission sentence of each licence: what the licence text itself says, not a title or a badge. */
const NOTICE = [
  {
    name: "MIT",
    re: /Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  },
  {
    name: "ISC",
    re: /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i,
  },
] as const;
const LICENCE_FILE = /(?:^|\/)(?:licen[cs]e|copying|notice)(?:\.[a-z]+)?$/i;
/** A line of the README that says where the project came from. */
const STARTER =
  /\b(?:starter|boilerplate)\b|\b(?:based on|forked from|cloned from|bootstrapped from|derived from)\b|\b(?:site|project|repo|repository|app)\s+(?:is|was)\s+(?:built|created|made|started)\s+(?:from|with|using)\b[^\n]*\btemplate\b/i;

/** The licence a package.json declares, when it is MIT or ISC. */
function declaredLicence(text: string): "MIT" | "ISC" | undefined {
  try {
    const m = JSON.parse(text) as { license?: unknown };
    const value =
      typeof m.license === "string"
        ? m.license
        : typeof (m.license as { type?: unknown } | undefined)?.type === "string"
          ? (m.license as { type: string }).type
          : "";
    const v = value.trim().toUpperCase();
    return v === "MIT" || v === "ISC" ? v : undefined;
  } catch {
    return undefined;
  }
}

export const starterLicenceNoticeMissing = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "The folder holds the MIT or ISC licence text of the starter the project was made from, with its copyright line.",
  estimateChanges:
    "Copy the licence file from the starter's repository; larger if more than one starter was used or nobody remembers which.",
  area: "Launch day",
  severity: "medium",
  title: "The licence notice of a starter project is not in the folder",
  what: "The folder says its code is MIT or ISC licensed, or says it was made from a starter or template, and no file in it holds the MIT or ISC licence text.",
  why: "The MIT and ISC licences let anyone use the code on one condition: the copyright and permission notice must stay with copies of it. Starting a client's site from a public starter and deleting its LICENSE file breaks that condition, and it is the kind of thing a client's lawyer or an acquirer finds in the first hour. Gaugeline cannot see where the code came from: it can only say that a notice is missing and what made that matter. It does not say that anything was copied.",
  fix: "Copy the starter's LICENSE file into the project (or its text into a NOTICE or THIRD_PARTY_LICENSES file), keeping the copyright line. If nothing from a starter is in the project, say so in the README, or change the license field in package.json.",
  tech: "static, reads the folder's text files (including a LICENSE, LICENCE, COPYING or NOTICE file with no extension) and makes no request; a notice is the permission sentence of the MIT or ISC licence found in any file; a finding when no file holds one and package.json declares MIT or ISC, or the README says the project is based on, forked or cloned from, or built from a starter, template or boilerplate, naming the file and line and never printing text; a licence file that holds some other text, or a folder the reader did not finish, is not sure; no notice and nothing that says where the code came from is not sure, never a pass; a notice found anywhere passes",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    for (const text of tree.files.values()) if (NOTICE.some((n) => n.re.test(text))) return [];
    const signals: { file: string; line: number; what: string }[] = [];
    for (const [path, text] of tree.files) {
      if (path !== "package.json" && !path.endsWith("/package.json")) continue;
      const licence = declaredLicence(text);
      if (licence !== undefined)
        signals.push({
          file: path,
          line: lineOf(text, Math.max(0, text.search(/"licen[cs]e"/))),
          what: `package.json declares the ${licence} licence`,
        });
    }
    const readme = tree.files.get("README.md");
    if (readme !== undefined) {
      const m = STARTER.exec(readme);
      if (m !== null)
        signals.push({
          file: "README.md",
          line: lineOf(readme, m.index),
          what: "the README says the project was made from a starter or template",
        });
    }
    const other = [...tree.files.keys()].find((p) => LICENCE_FILE.test(p));
    const left = [...tree.skipped.keys()].find(
      (p) => LICENCE_FILE.test(p) && tree.skipped.get(p) !== "secret-looking",
    );
    if (left !== undefined || tree.truncated || other !== undefined) {
      ctx.couldNotCheck?.(
        url,
        left !== undefined
          ? `${left} was not read (${tree.skipped.get(left)}), and it may hold the notice.`
          : other !== undefined
            ? `${other} holds a licence text that is not MIT or ISC, so Gaugeline cannot tell whether a starter's notice was kept.`
            : "the folder has more files than Gaugeline reads, so it cannot say no notice is in the files it left out.",
      );
      return [];
    }
    if (signals.length === 0) {
      ctx.couldNotCheck?.(
        url,
        "no MIT or ISC licence text is in the folder, and nothing in it says where the code came from, so Gaugeline cannot tell whether a notice was removed.",
      );
      return [];
    }
    return signals.map((s): Finding => ({
      checkId: ID,
      severity: "medium",
      title: this.title,
      evidence: `${s.file}:${s.line}: ${s.what}, and no file in the folder holds the MIT or ISC licence text.`,
      url,
      source: { file: s.file, line: s.line },
    }));
  },
});
