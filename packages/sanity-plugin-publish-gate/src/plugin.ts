/**
 * publishGate({ site, functionUrl, pages }): a Sanity plugin that puts a page check in front of
 * the Publish document action. It is a plain plugin object (a name and `document.actions`), so
 * `plugins: [publishGate({ ... })]` takes it as it takes one made with definePlugin. It imports
 * nothing from the Sanity package: the action it wraps is whatever the Studio hands it as `prev`.
 */
import { gateEndpoint } from "./request.js";
import { gatePublishAction, type GateAction, type GateConfig } from "./publish-action.js";
import { resolvePage } from "./resolve.js";

export type PublishGateOptions = GateConfig;

export function publishGate(options: PublishGateOptions) {
  // A wrong setup fails when the Studio loads, not at the first click.
  gateEndpoint(options.functionUrl);
  resolvePage({ _id: "setup", _type: "setup" }, { site: options.site, pages: {} });
  // The same wrapper for the same Publish action, so a re-resolve does not remount the button.
  const wrapped = new WeakMap<object, GateAction>();
  return {
    name: "sanity-plugin-publish-gate",
    document: {
      // Any action type fits (Sanity's own takes more props than the gate reads); only `action` is looked at.
      actions: <T extends { action?: string }>(prev: T[], _context?: unknown): T[] =>
        prev.map((action) => {
          if (action.action !== "publish") return action;
          let gated = wrapped.get(action);
          if (gated === undefined) {
            gated = gatePublishAction(action as unknown as GateAction, options);
            wrapped.set(action, gated);
          }
          return gated as unknown as T;
        }),
    },
  };
}
