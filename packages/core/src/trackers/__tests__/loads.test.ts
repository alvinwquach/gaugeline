import { describe, expect, it } from "vitest";
import { page } from "../../checks/__tests__/helpers.js";
import { FINGERPRINTS } from "../fingerprints.js";
import { analyticsLoads } from "../loads.js";

const GTM = "GTM-AB12CD3";
const GA = "G-TEST123456";
const gtmSnippet = (id: string) =>
  `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');`;
const withScripts = (...tags: { src?: string; inline?: string }[]) =>
  page({ scriptTags: tags.map((t, position) => ({ ...t, position })) });

describe("analyticsLoads: the fingerprint patterns it relies on", () => {
  it("the first GA4 pattern reads the gtag.js address and the second the config call", () => {
    const ga4 = FINGERPRINTS.find((f) => f.kind === "ga4");
    expect(ga4?.script[0]?.test(`https://www.googletagmanager.com/gtag/js?id=${GA}`)).toBe(true);
    expect(ga4?.script[1]?.test(`gtag('config', '${GA}')`)).toBe(true);
  });
});

describe("analyticsLoads: counting", () => {
  it("counts a container once per script that loads it, an inline snippet and a script address alike", () => {
    const loads = analyticsLoads(
      withScripts(
        { inline: gtmSnippet(GTM) },
        { src: `https://www.googletagmanager.com/gtm.js?id=${GTM}` },
        { inline: gtmSnippet("GTM-ZZ99YY8") },
      ),
    );
    expect([...loads.containers]).toEqual([
      [GTM, 2],
      ["GTM-ZZ99YY8", 1],
    ]);
  });

  it("the noscript iframe is the other half of one install, not a second load", () => {
    const p = page({
      scriptTags: [{ inline: gtmSnippet(GTM), position: 0 }],
      hops: [
        {
          url: "https://shop.example/menu",
          status: 200,
          headers: { "content-type": "text/html" },
          body: `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${GTM}"></iframe></noscript>`,
          ms: 1,
        },
      ],
    });
    expect(analyticsLoads(p).containers.get(GTM)).toBe(1);
  });

  it("counts gtag.js loads and config calls of one measurement id separately", () => {
    const loads = analyticsLoads(
      withScripts(
        { src: `https://www.googletagmanager.com/gtag/js?id=${GA}` },
        { inline: `gtag('config', '${GA}');` },
        { src: `https://www.googletagmanager.com/gtag/js?id=${GA}` },
        { inline: `gtag('config', '${GA}'); gtag('config', "${GA}");` },
      ),
    );
    expect(loads.gtagScripts.get(GA)).toBe(2);
    expect(loads.gtagConfigs.get(GA)).toBe(3);
    expect([...loads.ga4Ids]).toEqual([GA]);
  });

  it("a page with none has empty counts, and one analytics tag of each kind is one", () => {
    expect(analyticsLoads(withScripts()).containers.size).toBe(0);
    const one = analyticsLoads(
      withScripts({ inline: gtmSnippet(GTM) }, { inline: `gtag('config', '${GA}');` }),
    );
    expect(one.containers.get(GTM)).toBe(1);
    expect(one.gtagConfigs.get(GA)).toBe(1);
  });

  it("the same HTML gives the same counts", () => {
    const p = withScripts({ inline: gtmSnippet(GTM) }, { inline: gtmSnippet(GTM) });
    expect(analyticsLoads(p)).toEqual(analyticsLoads(p));
  });
});
