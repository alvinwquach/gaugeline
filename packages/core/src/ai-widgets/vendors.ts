import type { PageSnapshot } from "../snapshot.js";

/**
 * Third-party chat and AI assistant widgets (AI-11), found from what the page itself loads: a script address, an
 * iframe address or an inline snippet that sets the widget up. The table is data: a fixed list of vendors, each
 * with the hosts its widget loads from.
 *
 * Every host and snippet is from memory, not from a vendor's page (the vendors' sites were unreachable when this was
 * written): uncited. `ai` marks a vendor whose product is an assistant that answers with a language model (from the
 * vendor's own name and description, also uncited); a chat vendor that has added an AI feature is not marked,
 * because a page does not show which feature a site turned on.
 */
export interface AiWidgetVendor {
  id: string;
  label: string;
  /** True when the product is a model-driven assistant, false for a live-chat or support widget. */
  ai: boolean;
  /** Hosts the widget loads from. A host matches itself and its subdomains. */
  hosts: readonly string[];
  /** Text in an inline script that sets the widget up. Bounded: no open-ended quantifier. */
  inline?: RegExp;
}

export const AI_WIDGET_VENDORS: readonly AiWidgetVendor[] = Object.freeze([
  { id: "ada", label: "Ada", ai: true, hosts: ["static.ada.support"], inline: /\badaEmbed\b/ },
  {
    id: "botpress",
    label: "Botpress",
    ai: true,
    hosts: ["cdn.botpress.cloud", "files.bpcontent.cloud"],
    inline: /\bbotpressWebChat\b/,
  },
  { id: "botsonic", label: "Botsonic", ai: true, hosts: ["widget.botsonic.com"] },
  { id: "chatbase", label: "Chatbase", ai: true, hosts: ["chatbase.co"] },
  { id: "chatra", label: "Chatra", ai: false, hosts: ["call.chatra.io"], inline: /\bChatraID\b/ },
  {
    id: "crisp",
    label: "Crisp",
    ai: false,
    hosts: ["client.crisp.chat"],
    inline: /\bCRISP_WEBSITE_ID\b/,
  },
  { id: "customgpt", label: "CustomGPT", ai: true, hosts: ["cdn.customgpt.ai"] },
  {
    id: "drift",
    label: "Drift",
    ai: false,
    hosts: ["js.driftt.com"],
    inline: /\bdrift\.load\s*\(/,
  },
  { id: "elevenlabs", label: "ElevenLabs agent", ai: true, hosts: ["elevenlabs.io"] },
  {
    id: "freshchat",
    label: "Freshchat",
    ai: false,
    hosts: ["wchat.freshchat.com"],
    inline: /\bfcWidget\b/,
  },
  { id: "gorgias", label: "Gorgias chat", ai: false, hosts: ["config.gorgias.chat"] },
  { id: "hubspot-chat", label: "HubSpot chat", ai: false, hosts: ["js.usemessages.com"] },
  {
    id: "intercom",
    label: "Intercom",
    ai: false,
    hosts: ["widget.intercom.io", "js.intercomcdn.com"],
    inline: /\bintercomSettings\b/,
  },
  {
    id: "kommunicate",
    label: "Kommunicate",
    ai: true,
    hosts: ["widget.kommunicate.io"],
    inline: /\bkommunicateSettings\b/,
  },
  {
    id: "landbot",
    label: "Landbot",
    ai: false,
    hosts: ["cdn.landbot.io"],
    inline: /\bnew\s+Landbot\b/,
  },
  {
    id: "livechat",
    label: "LiveChat",
    ai: false,
    hosts: ["cdn.livechatinc.com"],
    inline: /\b__lc\.license\b/,
  },
  { id: "manychat", label: "ManyChat", ai: false, hosts: ["widget.manychat.com"] },
  { id: "olark", label: "Olark", ai: false, hosts: ["static.olark.com"] },
  { id: "openai-chatkit", label: "OpenAI ChatKit", ai: true, hosts: ["cdn.platform.openai.com"] },
  {
    id: "smartsupp",
    label: "Smartsupp",
    ai: false,
    hosts: ["smartsuppchat.com"],
    inline: /\b_smartsupp\b/,
  },
  { id: "tawk", label: "Tawk.to", ai: false, hosts: ["tawk.to"], inline: /\bTawk_API\b/ },
  { id: "tidio", label: "Tidio", ai: false, hosts: ["code.tidio.co"], inline: /\btidioChatCode\b/ },
  {
    id: "voiceflow",
    label: "Voiceflow",
    ai: true,
    hosts: ["cdn.voiceflow.com"],
    inline: /\bvoiceflow\.chat\.load\b/,
  },
  {
    id: "zendesk",
    label: "Zendesk widget",
    ai: false,
    hosts: ["static.zdassets.com", "ekr.zdassets.com"],
    inline: /\bzESettings\b/,
  },
] satisfies AiWidgetVendor[]);

export interface WidgetSighting {
  id: string;
  label: string;
  ai: boolean;
  how: "script" | "iframe" | "inline";
  /** The host it loads from, or "inline snippet" for a snippet that names no host. */
  host: string;
}

/** The host of a script or iframe address, lower case, or undefined for an address that is not http(s). */
function hostOf(src: string): string | undefined {
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.hostname.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/** True for the host itself and any subdomain of it, never for a name that only ends with the same letters. */
function underHost(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Every widget the page loads, once per vendor, in the order they first appear. A page that only names a vendor in
 * its text or a comment is not a sighting: only script and iframe addresses and inline scripts are read. The page
 * is the snapshot of one fetch; a widget a script adds after load is not seen.
 */
export function findAiWidgets(page: PageSnapshot): WidgetSighting[] {
  const out: WidgetSighting[] = [];
  const seen = new Set<string>();
  const add = (v: AiWidgetVendor, how: WidgetSighting["how"], host: string): void => {
    if (seen.has(v.id)) return;
    seen.add(v.id);
    out.push({ id: v.id, label: v.label, ai: v.ai, how, host });
  };
  const byAddress = (src: string, how: "script" | "iframe"): void => {
    const host = hostOf(src);
    if (host === undefined) return;
    const v = AI_WIDGET_VENDORS.find((x) => x.hosts.some((h) => underHost(host, h)));
    if (v) add(v, how, host);
  };
  // Document order: scripts and iframes carry the position the snapshot counted them at.
  const items: { position: number; run: () => void }[] = [];
  for (const tag of page.scriptTags ?? []) {
    if (tag.src !== undefined)
      items.push({ position: tag.position, run: () => byAddress(tag.src as string, "script") });
    else if (tag.inline !== undefined)
      items.push({
        position: tag.position,
        run: () => {
          const v = AI_WIDGET_VENDORS.find((x) => x.inline?.test(tag.inline as string));
          if (v) add(v, "inline", "inline snippet");
        },
      });
  }
  for (const frame of page.iframes ?? [])
    items.push({ position: frame.position, run: () => byAddress(frame.src, "iframe") });
  for (const item of items.sort((a, b) => a.position - b.position)) item.run();
  return out;
}

/**
 * Whether the owner's list allows this widget. An entry is a vendor id (any case) or a host: the widget's own host
 * or a parent of it (intercom.io allows widget.intercom.io). A different vendor, a name that only ends the same, or
 * a bare top-level domain never does.
 */
export function isAllowedWidget(sighting: WidgetSighting, allowed: readonly string[]): boolean {
  return allowed.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "") return false;
    if (entry === sighting.id) return true;
    if (!entry.includes(".")) return false;
    return sighting.host.includes(".") && underHost(sighting.host, entry);
  });
}
