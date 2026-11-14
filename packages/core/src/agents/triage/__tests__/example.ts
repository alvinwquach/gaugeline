/** Test helper: the groups of one eval answer, parsed (the model's text is JSON). */
import type { EvalRecording } from "../../../evals/index.js";

export interface ExampleGroup {
  cause: string;
  priority: "fix-first" | "fix-soon";
  findingIds: string[];
  summary: string;
}
export const exampleOutput = (
  rec: EvalRecording,
): { groups: ExampleGroup[]; alreadyWaiting?: string[] } =>
  JSON.parse(rec.text) as { groups: ExampleGroup[]; alreadyWaiting?: string[] };
