import * as z from "zod";
import { ConfigError } from "../errors.js";

/**
 * A Google Tag Manager container export (Admin > Export container), read into the few things the
 * tag rule checks need. Only the file is read: nothing here signs in to a tag manager.
 */

/** What a condition reads: the built-in variable on its left-hand side. */
export type TagSubject =
  | "page-url"
  | "page-path"
  | "page-hostname"
  | "click-url"
  | "click-id"
  | "click-classes"
  | "click-text"
  | "click-element"
  | "form-url"
  | "form-id"
  | "form-classes"
  | "form-text"
  | "form-element"
  | "event";

export type TagOperator = "equals" | "contains" | "starts-with" | "ends-with" | "regex" | "css";

export interface TagCondition {
  subject: TagSubject;
  operator: TagOperator;
  value: string;
  negate: boolean;
  ignoreCase: boolean;
  /** The rule as the tag manager shows it: {{Click URL}} contains "/wp-content/". */
  text: string;
}

export type TriggerKind = "page-view" | "click" | "link-click" | "form-submit" | "custom-event";

export interface TagTrigger {
  id: string;
  name: string;
  /** Undefined when the trigger type is not one this reads. */
  kind?: TriggerKind;
  /** The export's own type name, for messages ("SCROLL_DEPTH"). */
  type: string;
  conditions: TagCondition[];
  /** Why this trigger can't be judged (a type or condition this doesn't read). Never guessed. */
  unreadable?: string;
}

export interface TagEntry {
  id: string;
  name: string;
  type: string;
  /** What the tag sends, as a comparable key: two tags with the same key send the same event. */
  sends: string;
  /** "file_download to G-ABC123", for evidence. */
  label: string;
  firing: string[];
  paused: boolean;
}

export interface TagContainer {
  /** GTM-XXXXXXX, when the export names it. */
  publicId?: string;
  triggers: TagTrigger[];
  tags: TagEntry[];
}

/** gaugeline.tags.json: where the container export is, relative to that file. */
export const tagsConfigSchema = z
  .object({ container: z.string().trim().min(1, "must name the container export file") })
  .strict();
export type TagsConfig = z.infer<typeof tagsConfigSchema>;

/** Tag Manager's built-in "All Pages" trigger: tags reference it by this id; it isn't in the list. */
export const ALL_PAGES_TRIGGER_ID = "2147479553";

const VARIABLES: Readonly<Record<string, TagSubject>> = Object.freeze({
  "Page URL": "page-url",
  "Page Path": "page-path",
  "Page Hostname": "page-hostname",
  "Click URL": "click-url",
  "Click ID": "click-id",
  "Click Classes": "click-classes",
  "Click Text": "click-text",
  "Click Element": "click-element",
  "Form URL": "form-url",
  "Form ID": "form-id",
  "Form Classes": "form-classes",
  "Form Text": "form-text",
  "Form Element": "form-element",
  Event: "event",
  _event: "event",
});

const OPERATORS: Readonly<Record<string, TagOperator>> = Object.freeze({
  EQUALS: "equals",
  CONTAINS: "contains",
  STARTS_WITH: "starts-with",
  ENDS_WITH: "ends-with",
  MATCH_REGEX: "regex",
  CSS_SELECTOR: "css",
});

const KINDS: Readonly<Record<string, TriggerKind>> = Object.freeze({
  PAGEVIEW: "page-view",
  DOM_READY: "page-view",
  WINDOW_LOADED: "page-view",
  CLICK: "click",
  LINK_CLICK: "link-click",
  FORM_SUBMISSION: "form-submit",
  CUSTOM_EVENT: "custom-event",
});

const OPERATOR_WORDS: Readonly<Record<TagOperator, [string, string]>> = Object.freeze({
  equals: ["equals", "does not equal"],
  contains: ["contains", "does not contain"],
  "starts-with": ["starts with", "does not start with"],
  "ends-with": ["ends with", "does not end with"],
  regex: ["matches RegEx", "does not match RegEx"],
  css: ["matches CSS selector", "does not match CSS selector"],
});

const parameterSchema = z.looseObject({
  type: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  list: z.array(z.unknown()).optional(),
  map: z.array(z.unknown()).optional(),
});
type Parameter = z.infer<typeof parameterSchema>;

const conditionSchema = z.looseObject({
  type: z.string(),
  parameter: z.array(parameterSchema).default([]),
});
type RawCondition = z.infer<typeof conditionSchema>;

const triggerSchema = z.looseObject({
  triggerId: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  type: z.string(),
  filter: z.array(conditionSchema).optional(),
  autoEventFilter: z.array(conditionSchema).optional(),
  customEventFilter: z.array(conditionSchema).optional(),
});

const tagSchema = z.looseObject({
  tagId: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  type: z.string(),
  parameter: z.array(parameterSchema).optional(),
  firingTriggerId: z.array(z.union([z.string(), z.number()]).transform(String)).optional(),
  paused: z.boolean().optional(),
});

const exportSchema = z.looseObject({
  containerVersion: z.looseObject({
    container: z.looseObject({ publicId: z.string().optional() }).optional(),
    tag: z.array(tagSchema).optional(),
    trigger: z.array(triggerSchema).optional(),
  }),
});

function param(list: readonly Parameter[] | undefined, key: string): string | undefined {
  return list?.find((p) => p.key === key)?.value;
}

/** One condition, or the reason it can't be read. */
export function readCondition(raw: RawCondition): TagCondition | { unreadable: string } {
  const left = param(raw.parameter, "arg0") ?? "";
  const value = param(raw.parameter, "arg1") ?? "";
  const variable = /^\{\{(.+)\}\}$/.exec(left.trim())?.[1]?.trim();
  const subject = variable === undefined ? undefined : VARIABLES[variable];
  if (subject === undefined)
    return { unreadable: `a condition reads ${left || "nothing"}, a variable this doesn't read` };
  const operator = OPERATORS[raw.type];
  if (operator === undefined)
    return { unreadable: `${left} uses the ${raw.type} comparison, which this doesn't read` };
  const negate = param(raw.parameter, "negate") === "true";
  const ignoreCase = param(raw.parameter, "ignore_case") === "true";
  if (operator === "regex") {
    try {
      new RegExp(value, ignoreCase ? "i" : "");
    } catch {
      return { unreadable: `${left} matches RegEx "${value}", which is not a valid expression` };
    }
  }
  const words = OPERATOR_WORDS[operator][negate ? 1 : 0];
  return { subject, operator, value, negate, ignoreCase, text: `${left} ${words} "${value}"` };
}

/** What the tag sends: GA4 events by name and destination, any other tag by its full settings. */
function sends(tag: z.infer<typeof tagSchema>): { sends: string; label: string } {
  const p = tag.parameter;
  if (tag.type === "gaawe") {
    const event = param(p, "eventName") ?? "";
    const to = param(p, "measurementIdOverride") ?? param(p, "measurementId") ?? "";
    return { sends: `gaawe ${event} ${to}`, label: to ? `${event} to ${to}` : event };
  }
  const settings = [...(p ?? [])]
    .map((x) => JSON.stringify([x.key, x.type, x.value, x.list, x.map]))
    .sort();
  return { sends: `${tag.type} ${settings.join(",")}`, label: `the same ${tag.type} tag` };
}

/** Read a parsed container export. A file that isn't one is a ConfigError, like any bad setting. */
export function readContainer(json: unknown, file = "the container export"): TagContainer {
  const parsed = exportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "the file";
    throw new ConfigError(
      `${file} is not a Tag Manager container export: ${where}: ${issue?.message ?? "not valid"}.`,
      {
        hint: "Export it from Tag Manager: Admin > Export container, then point gaugeline.tags.json at the file.",
      },
    );
  }
  const version = parsed.data.containerVersion;
  const triggers: TagTrigger[] = (version.trigger ?? []).map((t) => {
    const kind = KINDS[t.type];
    const conditions: TagCondition[] = [];
    let unreadable: string | undefined =
      kind === undefined ? `${t.type} triggers are not read` : undefined;
    for (const raw of [
      ...(t.autoEventFilter ?? []),
      ...(t.filter ?? []),
      ...(t.customEventFilter ?? []),
    ]) {
      const c = readCondition(raw);
      if ("unreadable" in c) unreadable ??= c.unreadable;
      else conditions.push(c);
    }
    return {
      id: t.triggerId,
      name: t.name,
      type: t.type,
      ...(kind ? { kind } : {}),
      conditions,
      ...(unreadable ? { unreadable } : {}),
    };
  });
  const tags: TagEntry[] = (version.tag ?? []).map((t) => ({
    id: t.tagId,
    name: t.name,
    type: t.type,
    ...sends(t),
    firing: t.firingTriggerId ?? [],
    paused: t.paused === true,
  }));
  // The built-in All Pages trigger isn't listed in the export; tags that use it name its id.
  if (
    tags.some((t) => t.firing.includes(ALL_PAGES_TRIGGER_ID)) &&
    !triggers.some((t) => t.id === ALL_PAGES_TRIGGER_ID)
  )
    triggers.unshift({
      id: ALL_PAGES_TRIGGER_ID,
      name: "All Pages",
      type: "PAGEVIEW",
      kind: "page-view",
      conditions: [],
    });
  const publicId = version.container?.publicId;
  return { ...(publicId ? { publicId } : {}), triggers, tags };
}
