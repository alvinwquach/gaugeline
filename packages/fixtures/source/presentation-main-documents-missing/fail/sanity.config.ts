import { defineConfig } from "sanity";
import { presentationTool } from "sanity/presentation";
import { structureTool } from "sanity/structure";

export default defineConfig({
  name: "default",
  title: "Larkfield Bakery",
  projectId: "larkfield",
  dataset: "production",
  plugins: [
    structureTool(),
    presentationTool({
      previewUrl: { previewMode: { enable: "/api/draft-mode/enable" } },
    }),
  ],
});
