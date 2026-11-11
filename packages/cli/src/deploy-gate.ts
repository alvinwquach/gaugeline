import { parseAddress } from "@gaugeline/core";

/**
 * gaugeline deploy-gate: which preview to check. The hosts' build and CI environments already know the
 * address of the preview they made, so the gate reads it from there when none is typed, and refuses to run
 * when the environment says it is a production deployment: a gate for previews must not be pointed at
 * production as if it were one. The environment is read here and nowhere else; only the address is ever
 * shown, and no message repeats a value it refused (a value can carry a password).
 *
 * The variable names are the hosts' documented ones. They could not be confirmed against the vendors'
 * pages while this was written (the pages were unreachable), so docs/guides/deploy-gates.md marks them
 * "uncited" and the table below is the one place to change them.
 */
export type GateHost = "vercel" | "netlify" | "cloudflare-pages";

export interface GateAddress {
  ok: true;
  /** The address to check, with a scheme. */
  address: string;
  /** The host whose variables were found, if any: named in the output, never used to change what is checked. */
  host?: GateHost;
  source: "argument" | "environment";
}
export interface GateRefusal {
  ok: false;
  message: string;
  hint: string;
}
type Env = Readonly<Record<string, string | undefined>>;

const NAMES: Record<GateHost, string> = {
  vercel: "Vercel",
  netlify: "Netlify",
  "cloudflare-pages": "Cloudflare Pages",
};
export const GATE_ENV_HINT =
  "Vercel sets VERCEL_ENV and VERCEL_URL, Netlify CONTEXT and DEPLOY_PRIME_URL, Cloudflare Pages CF_PAGES and CF_PAGES_URL. Or type the preview's address: gaugeline deploy-gate https://deploy-preview-7--yoursite.netlify.app";

/** What one host's environment says about this build. */
type Kind = { kind: "preview" } | { kind: "production" } | { kind: "other"; why: string };

function set(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** Cloudflare Pages does not say which deployment is production: its production branch is main or master. */
const CLOUDFLARE_PRODUCTION_BRANCHES: readonly string[] = ["main", "master"];

const HOSTS: Record<
  GateHost,
  { detect: (env: Env) => boolean; kind: (env: Env) => Kind; variables: readonly string[] }
> = {
  vercel: {
    detect: (env) => set(env, "VERCEL_ENV") !== undefined,
    kind: (env) => {
      const v = set(env, "VERCEL_ENV");
      if (v === "preview") return { kind: "preview" };
      if (v === "production") return { kind: "production" };
      return { kind: "other", why: `VERCEL_ENV is "${v ?? ""}", not preview` };
    },
    variables: ["VERCEL_URL"],
  },
  netlify: {
    detect: (env) => set(env, "NETLIFY") === "true" || set(env, "CONTEXT") !== undefined,
    kind: (env) => {
      const v = set(env, "CONTEXT");
      if (v === "deploy-preview" || v === "branch-deploy") return { kind: "preview" };
      if (v === "production") return { kind: "production" };
      return {
        kind: "other",
        why:
          v === undefined
            ? "CONTEXT is not set, so Gaugeline cannot tell a preview from production"
            : `CONTEXT is "${v}", not deploy-preview or branch-deploy`,
      };
    },
    variables: ["DEPLOY_PRIME_URL", "DEPLOY_URL"],
  },
  "cloudflare-pages": {
    detect: (env) => {
      const v = set(env, "CF_PAGES");
      return v !== undefined && v !== "0";
    },
    kind: (env) => {
      const branch = set(env, "CF_PAGES_BRANCH");
      if (branch === undefined)
        return {
          kind: "other",
          why: "CF_PAGES_BRANCH is not set, so Gaugeline cannot tell a preview from production",
        };
      return CLOUDFLARE_PRODUCTION_BRANCHES.includes(branch)
        ? { kind: "production" }
        : { kind: "preview" };
    },
    variables: ["CF_PAGES_URL"],
  },
};

const refuse = (message: string, hint: string): GateRefusal => ({ ok: false, message, hint });

/** A value from a host's variable: https, a plain host, no user name or password, no path, query or fragment. */
function fromVariable(
  host: GateHost,
  name: string,
  raw: string,
  allowPrivate: boolean,
): GateAddress | GateRefusal {
  const bad = (what: string) =>
    refuse(
      `${NAMES[host]}'s ${name} ${what}. The value is not shown.`,
      "It should be the preview's address, such as https://deploy-preview-7--yoursite.netlify.app. Or type the address: gaugeline deploy-gate <address>",
    );
  // Vercel's VERCEL_URL is a host name with no scheme.
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (/\s/.test(text)) return bad("is not a plain address");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return bad("is not a web address");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    return bad("is not an https address");
  if (url.username !== "" || url.password !== "") return bad("has a user name or password in it");
  if (url.hostname === "") return bad("has no host name");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "")
    return bad("is not a plain host (it has a path, a query or a fragment)");
  return { ok: true, address: url.href, host, source: "environment" };
}

export function resolveDeployGate(
  env: Env,
  typed: string | undefined,
  opts: { allowPrivate?: boolean } = {},
): GateAddress | GateRefusal {
  const found = (Object.keys(HOSTS) as GateHost[]).filter((h) => HOSTS[h].detect(env));
  const kinds = found.map((h) => [h, HOSTS[h].kind(env)] as const);
  // Production first, whatever was typed: a gate for previews does not run on a production deployment.
  for (const [h, k] of kinds)
    if (k.kind === "production")
      return refuse(
        `${NAMES[h]}'s environment says this is a production deployment, and deploy-gate checks previews only.`,
        "Run it in the preview's build or CI job. To check production, use gaugeline <address> as usual.",
      );
  for (const [h, k] of kinds)
    if (k.kind === "other")
      return refuse(`${NAMES[h]}: ${k.why}.`, "deploy-gate checks previews only.");

  if (typed !== undefined) {
    const parsed = parseAddress(typed);
    if (!parsed.ok) return refuse(`The preview's address: ${parsed.reason}`, GATE_ENV_HINT);
    if (parsed.url.username !== "" || parsed.url.password !== "")
      return refuse(
        "The preview's address has a user name or password in it: Gaugeline does not take one in an address.",
        "For a preview behind a password, see Checking a protected preview in the docs.",
      );
    return {
      ok: true,
      address: parsed.url.href,
      source: "argument",
      ...(found[0] ? { host: found[0] } : {}),
    };
  }

  if (found.length === 0)
    return refuse(
      "No address was given, and no Vercel, Netlify or Cloudflare Pages preview was found in the environment.",
      GATE_ENV_HINT,
    );
  if (found.length > 1)
    return refuse(
      `More than one host's variables are set (${found.map((h) => NAMES[h]).join(" and ")}), so Gaugeline will not guess which preview you mean.`,
      "Type the preview's address: gaugeline deploy-gate <address>",
    );
  const host = found[0] as GateHost;
  for (const name of HOSTS[host].variables) {
    const raw = set(env, name);
    if (raw !== undefined) return fromVariable(host, name, raw, opts.allowPrivate === true);
  }
  return refuse(
    `${NAMES[host]}'s environment is set but ${HOSTS[host].variables.join(" and ")} ${HOSTS[host].variables.length > 1 ? "are" : "is"} empty, so there is no preview address.`,
    "Type the preview's address: gaugeline deploy-gate <address>",
  );
}

/** The gate's one-line verdict. */
export function gateVerdict(host: GateHost | undefined, high: number, block: boolean): string {
  const what = `${high} fix-first finding${high === 1 ? "" : "s"}`;
  const state = high === 0 ? "clear" : block ? `blocked (${what})` : `would block (${what})`;
  return `gate: ${state}${host ? ` [${NAMES[host]} preview]` : ""}${high > 0 && !block ? "; report only, add --block to fail the build" : ""}`;
}
