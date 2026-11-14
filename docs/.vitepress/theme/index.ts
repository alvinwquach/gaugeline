import { h } from "vue";
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import type { App } from "vue";
import ChecksList from "./ChecksList.vue";
import PlanTool from "./PlanTool.vue";
import RedirectTool from "./RedirectTool.vue";

/**
 * Pages for features that have not shipped carry `notReleased: true` in their front matter. The
 * theme shows the same "Not released yet" callout the site shows, so the page text stays as written.
 */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: App }) {
    app.component("ChecksList", ChecksList);
    app.component("RedirectTool", RedirectTool);
    app.component("PlanTool", PlanTool);
  },
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => {
        const { frontmatter } = useData();
        if (frontmatter.value.notReleased !== true) return null;
        return h("div", { class: "custom-block warning not-released" }, [
          h("p", [
            h("b", "Not released yet."),
            " This page describes a feature that is planned, not shipped.",
          ]),
        ]);
      },
    });
  },
};
