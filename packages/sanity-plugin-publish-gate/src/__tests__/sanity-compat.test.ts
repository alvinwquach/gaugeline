/// <reference lib="dom" />
/**
 * Compatibility with Sanity's own types. This file is compiled by `pnpm typecheck` against the
 * pinned `sanity` devDependency: if the plugin stops fitting `plugins: []`, the document actions
 * resolver, or `DocumentActionComponent`, the typecheck fails. The runtime assertions only prove the
 * shapes are what the types say.
 */
import {
  defineConfig,
  type DocumentActionComponent,
  type DocumentActionConfirmDialogProps,
  type PluginOptions,
} from "sanity";
import { describe, expect, it } from "vitest";
import { publishGate } from "../plugin.js";
import type { GateConfirmDialog } from "../publish-action.js";

const plugin = publishGate({
  site: "https://lantern-yard.example",
  functionUrl: "https://gate.lantern-yard.example/check",
  pages: { page: "/{slug}", siteSettings: null },
});

// The plugin is a Sanity plugin object, and goes where plugins go.
const asPlugin: PluginOptions = plugin;
export const config = defineConfig({
  name: "default",
  projectId: "lanternyard",
  dataset: "production",
  plugins: [plugin],
});
// The resolver takes and gives Sanity's own action type, and is accepted as `document.actions`.
const resolved: DocumentActionComponent[] = plugin.document.actions(
  [] as DocumentActionComponent[],
);
export const withActions = defineConfig({
  name: "other",
  projectId: "lanternyard",
  dataset: "production",
  document: { actions: plugin.document.actions },
});

// The dialog the gate opens is a dialog Sanity accepts.
export const dialogFits = (d: GateConfirmDialog): DocumentActionConfirmDialogProps => d;

describe("compatibility with Sanity's types (checked by the typecheck)", () => {
  it("the plugin object has the name and the actions resolver Sanity reads", () => {
    expect(asPlugin.name).toBe("sanity-plugin-publish-gate");
    expect(resolved).toEqual([]);
    expect(config).toBeDefined();
    expect(withActions).toBeDefined();
  });
});
