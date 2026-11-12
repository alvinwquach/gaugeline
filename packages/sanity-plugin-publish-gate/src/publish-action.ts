/**
 * The Publish button. It wraps Sanity's own Publish action and adds one question first: is the page
 * this document renders to right? The answer comes from the Function you own (request.ts). A clean
 * page publishes at once; a page with problems, or a check that could not run, holds the button and
 * shows why; a person can confirm publishing anyway. Whatever happens, the plugin itself never
 * writes or publishes: the only thing that publishes is Sanity's own action, which it calls.
 *
 * State is local to the Studio session (gate-state.ts): no dataset write, no storage, no request
 * to record an override.
 */
import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { couldNotCheck } from "./answer.js";
import { canPublish, gateReduce, IDLE } from "./gate-state.js";
import { heldLabel, heldMessage } from "./held-message.js";
import { requestGate, type GateFetch } from "./request.js";
import { resolvePage, type GateDocument, type PageRules } from "./resolve.js";

/** What of a document the gate reads (Sanity's own props carry more). */
export interface GateActionDocument {
  _id: string;
  _type: string;
  _rev?: string;
}
export interface GateActionProps {
  id: string;
  type: string;
  draft: GateActionDocument | null;
  published: GateActionDocument | null;
  revision?: string;
}
/** What of an action description the gate reads and sets. Sanity's own description has more and passes through. */
export interface GateDescription {
  label: string;
  disabled?: boolean;
  tone?: string;
  title?: ReactNode;
  onHandle?: () => void;
  dialog?: unknown;
}
export type GateAction = ((props: GateActionProps) => GateDescription | null) & {
  action?: string;
  displayName?: string;
};

export interface GateConfig {
  site: string;
  functionUrl: string;
  pages: PageRules;
  /** Let a check that could not run through. Default false: held, with a person-confirmed override. */
  failOpen?: boolean;
  timeoutMs?: number;
  fetch?: GateFetch;
}

export function gatePublishAction(Original: GateAction, config: GateConfig): GateAction {
  const siteOrigin = new URL(config.site).origin;
  const failOpen = config.failOpen === true;

  const Gated: GateAction = (props) => {
    const original = Original(props);
    const [state, dispatch] = useReducer(gateReduce, IDLE);
    const doc = props.draft ?? props.published;
    const rev = String(doc?._rev ?? props.revision ?? "");
    const resolved = doc
      ? resolvePage(doc as unknown as GateDocument, { site: config.site, pages: config.pages })
      : ({ kind: "no-page", reason: "" } as const);
    // The latest of everything an async answer needs, read when it arrives, not when it was asked.
    const latest = useRef({ original, rev, state });
    latest.current = { original, rev, state };
    const alive = useRef(true);
    const seenRev = useRef(rev);
    useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
      };
    }, []);
    // The document changed: the answer, and any override, no longer describe it.
    useEffect(() => {
      if (seenRev.current === rev) return;
      seenRev.current = rev;
      dispatch({ type: "reset" });
    }, [rev]);

    // Not gated: a document with no page, or Sanity has already disabled Publish.
    if (original === null || original.disabled === true || resolved.kind === "no-page")
      return original;

    const publish = () => latest.current.original?.onHandle?.();
    const start = () => {
      if (latest.current.state.name === "checking") return;
      const url = resolved.kind === "page" ? resolved.url : "";
      const startedRev = latest.current.rev;
      dispatch({ type: "check", url });
      void (async () => {
        const answer =
          resolved.kind === "page"
            ? await requestGate({
                functionUrl: config.functionUrl,
                pageUrl: url,
                ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
                ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
              }).catch(() => couldNotCheck(url, "The gate could not be reached."))
            : couldNotCheck("", resolved.reason);
        // A late answer, for a document that has changed or a Studio that has closed it, is dropped.
        if (!alive.current || latest.current.rev !== startedRev) return;
        dispatch({ type: "answer", answer });
        if (canPublish(gateReduce({ name: "checking", url }, { type: "answer", answer }), failOpen))
          publish();
      })();
    };

    if (state.name === "override-confirmed")
      return { ...original, label: `${original.label} (overridden)`, tone: "caution" };
    if (canPublish(state, failOpen)) return original;
    if (state.name === "checking")
      return { ...original, label: "Checking the page...", disabled: true, onHandle: undefined };
    if (state.name === "findings" || state.name === "could-not-check")
      return {
        ...original,
        label: heldLabel(state.answer),
        disabled: true,
        tone: "caution",
        onHandle: undefined,
        title:
          state.answer.status === "findings"
            ? `${state.answer.url} has problems`
            : (state.answer.reason ?? "The page could not be checked."),
        dialog: {
          type: "confirm",
          tone: "caution",
          message: heldMessage(state.answer, siteOrigin),
          confirmButtonText: "Publish anyway",
          cancelButtonText: "Keep editing",
          onConfirm: () => {
            dispatch({ type: "confirm-override" });
            publish();
          },
          onCancel: () => dispatch({ type: "reset" }),
        },
      };
    return { ...original, onHandle: start };
  };
  Gated.action = "publish";
  Gated.displayName = `PublishGate(${Original.displayName ?? "PublishAction"})`;
  return Gated;
}
