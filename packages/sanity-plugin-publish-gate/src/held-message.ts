/**
 * What the Studio shows when Publish is held. Built from React elements whose children are plain
 * strings, so every piece of text from the Function reaches the screen as text: there is no
 * raw-HTML property and no markup is ever parsed. A finding's address becomes a link only
 * when it is an http(s) address on the configured site with no user name or password.
 */
import { createElement as h, type ReactNode } from "react";
import type { GateAnswer } from "./answer.js";

/** The address as a link target, or undefined when it is not on the site. */
export function linkTarget(address: string, siteOrigin: string): string | undefined {
  if (!URL.canParse(address)) return undefined;
  const url = new URL(address);
  const web = url.protocol === "https:" || url.protocol === "http:";
  return web && url.origin === siteOrigin && url.username === "" && url.password === ""
    ? url.href
    : undefined;
}

export function heldLabel(answer: GateAnswer): string {
  const n = answer.findings.length;
  return answer.status === "findings"
    ? `Held: ${n} problem${n === 1 ? "" : "s"}`
    : "Held: could not check the page";
}

export function heldMessage(answer: GateAnswer, siteOrigin: string): ReactNode {
  const note = h(
    "p",
    { key: "note" },
    "Publishing anyway is not recorded anywhere beyond this Studio session.",
  );
  if (answer.status !== "findings")
    return h(
      "div",
      null,
      h(
        "p",
        { key: "why" },
        `The page could not be checked: ${answer.reason ?? "no reason given"}`,
      ),
      note,
    );
  const items = answer.findings.map((f, i) => {
    const href = linkTarget(f.url, siteOrigin);
    return h(
      "li",
      { key: `${i}:${f.id}` },
      `${f.severity} ${f.id}: ${f.title} `,
      href === undefined
        ? h("span", { key: "at" }, f.url)
        : h("a", { key: "at", href, target: "_blank", rel: "noopener noreferrer" }, f.url),
      ` ${f.evidence}`,
    );
  });
  return h(
    "div",
    null,
    h("p", { key: "why" }, `Publish is held: the page ${answer.url} has problems.`),
    h("ul", { key: "list" }, items),
    note,
  );
}
