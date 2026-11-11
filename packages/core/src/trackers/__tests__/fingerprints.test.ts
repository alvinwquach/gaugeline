import { describe, expect, it } from "vitest";
import { page } from "../../checks/__tests__/helpers.js";
import { PROVIDERS } from "../../forms/providers.js";
import {
  containerIds,
  decodeContainer,
  FINGERPRINTS,
  findTrackers,
  findTrackersInContainer,
} from "../fingerprints.js";

const withScripts = (...tags: { src?: string; inline?: string }[]) =>
  page({ scriptTags: tags.map((t, position) => ({ ...t, position })) });

const kinds = (p: ReturnType<typeof page>) => findTrackers(p).map((t) => [t.kind, ...t.ids]);

describe("tracker fingerprints: unit", () => {
  it("lists the kinds the entry names, then the form services' own tracking code", () => {
    expect(FINGERPRINTS.map((f) => f.kind)).toEqual([
      "meta-pixel",
      "tiktok-pixel",
      "linkedin-insight",
      "ga4",
      "gtm",
      "hotjar",
      "clarity",
      "fullstory",
      "logrocket",
      "mouseflow",
      "pardot-tracking",
      "hubspot-tracking",
      "marketo-tracking",
    ]);
  });

  it.each([
    [
      "Meta pixel, from the init call",
      { inline: "fbq('init', '123456789012345'); fbq('track', 'PageView');" },
      ["meta-pixel", "123456789012345"],
    ],
    [
      "Meta pixel, from the loader address alone (no id in the code)",
      { src: "https://connect.facebook.net/en_US/fbevents.js" },
      ["meta-pixel"],
    ],
    [
      "TikTok pixel, from ttq.load",
      { inline: "ttq.load('CABCDE1234FGHIJ5678'); ttq.page();" },
      ["tiktok-pixel", "CABCDE1234FGHIJ5678"],
    ],
    [
      "TikTok pixel, from the sdkid in the address",
      { src: "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CABCDE1234FGHIJ5678" },
      ["tiktok-pixel", "CABCDE1234FGHIJ5678"],
    ],
    [
      "LinkedIn Insight Tag, from the partner id",
      {
        inline:
          '_linkedin_partner_id = "5100001"; window._linkedin_data_partner_ids.push(_linkedin_partner_id);',
      },
      ["linkedin-insight", "5100001"],
    ],
    [
      "LinkedIn Insight Tag, from the script alone",
      { src: "https://snap.licdn.com/li.lms-analytics/insight.min.js" },
      ["linkedin-insight"],
    ],
    [
      "GA4, from the gtag address",
      { src: "https://www.googletagmanager.com/gtag/js?id=G-ABCD123456" },
      ["ga4", "G-ABCD123456"],
    ],
    [
      "GA4, from a config call",
      { inline: 'gtag("config", "G-ABCD123456");' },
      ["ga4", "G-ABCD123456"],
    ],
    [
      "GTM, from the container address",
      { src: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234" },
      ["gtm", "GTM-ABC1234"],
    ],
    [
      "GTM, from the standard snippet",
      { inline: "(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC1234');" },
      ["gtm", "GTM-ABC1234"],
    ],
    [
      "Hotjar, from the file name",
      { src: "https://static.hotjar.com/c/hotjar-3400001.js?sv=6" },
      ["hotjar", "3400001"],
    ],
    [
      "Hotjar, from hjid",
      { inline: "h._hjSettings={hjid:3400001,hjsv:6};" },
      ["hotjar", "3400001"],
    ],
    [
      "Microsoft Clarity, from the snippet",
      {
        inline: '(function(c,l,a,r,i,t,y){})(window, document, "clarity", "script", "abcd1234ef");',
      },
      ["clarity", "abcd1234ef"],
    ],
    [
      "Microsoft Clarity, from the address",
      { src: "https://www.clarity.ms/tag/abcd1234ef" },
      ["clarity", "abcd1234ef"],
    ],
    ["FullStory, from the org", { inline: "_fs_org = 'XYZ12';" }, ["fullstory", "XYZ12"]],
    ["FullStory, from the script", { src: "https://edge.fullstory.com/s/fs.js" }, ["fullstory"]],
    [
      "LogRocket, from init",
      { inline: "LogRocket.init('ab12cd/meadowlark-clinic');" },
      ["logrocket", "ab12cd/meadowlark-clinic"],
    ],
    [
      "Mouseflow, from the project file",
      { src: "https://cdn.mouseflow.com/projects/0a1b2c3d-0a1b-2c3d-4e5f-0a1b2c3d4e5f.js" },
      ["mouseflow", "0a1b2c3d-0a1b-2c3d-4e5f-0a1b2c3d4e5f"],
    ],
    [
      "HubSpot tracking code",
      { src: "https://js.hs-scripts.com/1234567.js" },
      ["hubspot-tracking"],
    ],
    ["Pardot tracking code", { inline: "piAId = '100001';" }, ["pardot-tracking"]],
    [
      "Marketo tracking code",
      { src: "https://munchkin.marketo.net/munchkin.js" },
      ["marketo-tracking"],
    ],
  ] as const)("%s", (_name, tag, expected) => {
    expect(kinds(withScripts(tag))).toEqual([[...expected]]);
  });

  it("reads the noscript fallback tags from the HTML, and says they are only in the HTML", () => {
    const p = page({
      hops: [
        {
          url: "https://x.example/",
          status: 200,
          headers: {},
          ms: 1,
          body: '<noscript><img src="https://www.facebook.com/tr?id=123456789012345&ev=PageView&noscript=1"></noscript><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC1234"></iframe></noscript>',
        },
      ],
    });
    expect(findTrackers(p)).toEqual([
      expect.objectContaining({ kind: "meta-pixel", ids: ["123456789012345"], how: "markup" }),
      expect.objectContaining({ kind: "gtm", ids: ["GTM-ABC1234"], how: "markup" }),
    ]);
  });

  it("merges the address and the init call of one tracker, and lists ids once, sorted", () => {
    const p = withScripts(
      { src: "https://connect.facebook.net/en_US/fbevents.js" },
      {
        inline:
          "fbq('init','999999999999'); fbq('init', '123456789012345'); fbq('init','123456789012345');",
      },
    );
    expect(findTrackers(p)).toEqual([
      expect.objectContaining({
        kind: "meta-pixel",
        ids: ["123456789012345", "999999999999"],
        how: "script",
      }),
    ]);
  });

  it("never reads a mention in the page's text: only scripts and the noscript tags count", () => {
    const p = page({
      hops: [
        {
          url: "https://x.example/",
          status: 200,
          headers: {},
          ms: 1,
          body: "<p>Add fbq('init', '123456789012345') and connect.facebook.net/en_US/fbevents.js to your page.</p>",
        },
      ],
    });
    expect(findTrackers(p)).toEqual([]);
  });

  it("finds nothing on a page with no trackers, or in code that only looks similar", () => {
    expect(findTrackers(page())).toEqual([]);
    expect(kinds(withScripts({ inline: "var fbqueue = []; var gtagging = 1;" }))).toEqual([]);
    expect(
      kinds(withScripts({ src: "https://www.googletagmanager.com/gtag/js?id=AW-123456789" })),
    ).toEqual([]);
  });

  it("gives the same answer for the same page", () => {
    const p = withScripts({
      inline: "fbq('init','123456789012345'); ttq.load('CABCDE1234FGHIJ5678');",
    });
    expect(findTrackers(p)).toEqual(findTrackers(p));
  });

  it("the form services' expression is the one the lead checks use (one list)", () => {
    for (const p of PROVIDERS.filter((x) => x.trackingScript)) {
      const f = FINGERPRINTS.find((x) => x.kind === `${p.id}-tracking`);
      expect(f?.script[0]?.source).toBe(p.trackingScript?.source);
    }
  });

  it("containerIds lists the GTM ids, sorted", () => {
    const p = withScripts(
      { src: "https://www.googletagmanager.com/gtm.js?id=GTM-ZZZ9999" },
      { src: "https://www.googletagmanager.com/gtm.js?id=GTM-AAA1111" },
    );
    expect(containerIds(findTrackers(p))).toEqual(["GTM-AAA1111", "GTM-ZZZ9999"]);
    expect(containerIds([])).toEqual([]);
  });
});

describe("tag manager container text", () => {
  it("decodes the escapes GTM writes into a custom tag's string", () => {
    expect(decodeContainer('fbq(\\x27init\\x27,\\x27123\\x27) \\u003cb\\u003e \\"x\\" \\/')).toBe(
      "fbq('init','123') <b> \"x\" /",
    );
  });

  it("finds a Meta pixel and a TikTok pixel in a custom HTML tag, and GA4 in a tag's settings", () => {
    const text = [
      '{"function":"__html","vtp_html":"\\x3cscript\\x3efbq(\\x27init\\x27,\\x27123456789012345\\x27);\\x3c\\/script\\x3e"},',
      '{"function":"__html","vtp_html":"\\u003cscript\\u003ettq.load(\\u0027CABCDE1234FGHIJ5678\\u0027)\\u003c\\/script\\u003e"},',
      '{"function":"__gaawc","vtp_measurementId":"G-ABCD123456"}',
    ].join("\n");
    expect(findTrackersInContainer(text).map((t) => [t.kind, ...t.ids])).toEqual([
      ["meta-pixel", "123456789012345"],
      ["tiktok-pixel", "CABCDE1234FGHIJ5678"],
      ["ga4", "G-ABCD123456"],
    ]);
  });

  it("does not list the container itself", () => {
    expect(findTrackersInContainer("'script','dataLayer','GTM-ABC1234'")).toEqual([]);
  });

  it("finds nothing in a container with no trackers", () => {
    expect(findTrackersInContainer('{"function":"__cvt_1_2","vtp_x":1}')).toEqual([]);
  });
});
