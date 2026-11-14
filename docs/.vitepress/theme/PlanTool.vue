<script setup lang="ts">
import { ref } from "vue";
import {
  PLAN_COMMAND,
  ShapeError,
  lintPlan,
  parsePlanSheet,
  type Issue,
  type PlanRule,
  type PlanToolRow,
} from "../../../packages/core/src/tools/lint";

// The sheet is read in this page and never uploaded or stored.
const text = ref("");
const rows = ref<PlanToolRow[]>([]);
const issues = ref<Issue<PlanRule>[] | null>(null);
const problem = ref("");
const LABEL: Record<PlanRule, string> = {
  "no-destination": "No destination",
  "shared-title": "Shared title",
};

function check() {
  try {
    rows.value = parsePlanSheet(text.value);
    issues.value = lintPlan(rows.value);
    problem.value = "";
  } catch (err) {
    issues.value = null;
    problem.value = err instanceof ShapeError ? err.message : String(err);
  }
}

async function upload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  text.value = await file.text();
  check();
}
</script>

<template>
  <div class="gl-tool">
    <label for="plan-sheet"><b>Your launch plan</b>: columns Old URL, New URL and Title</label>
    <textarea
      id="plan-sheet"
      v-model="text"
      data-testid="plan-input"
      rows="10"
      spellcheck="false"
      placeholder="Old URL,New URL,Title&#10;/old-about,/about,About us | Your site"
    />
    <p>
      <label
        >Or a file (CSV or a spreadsheet's tab-separated copy):
        <input type="file" accept=".csv,.tsv,.txt" @change="upload"
      /></label>
    </p>
    <button type="button" data-testid="plan-check" @click="check">Check the plan</button>
    <div v-if="problem" class="custom-block warning" data-testid="plan-problem">
      <p>{{ problem }}</p>
    </div>
    <div v-if="issues" data-testid="plan-results">
      <p v-if="issues.length === 0">
        No problems in {{ rows.length }} row{{ rows.length === 1 ? "" : "s" }}.
      </p>
      <ul>
        <li v-for="i in issues" :key="i.rule + i.lines.join()" :data-rule="i.rule">
          <b>{{ LABEL[i.rule] }}.</b> {{ i.message }}
        </li>
      </ul>
      <p>Run the full check locally (duplicates, titles, slugs, keywords and the 301 map):</p>
      <pre data-testid="plan-command"><code>{{ PLAN_COMMAND }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.gl-tool textarea {
  width: 100%;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 8px;
  margin-top: 6px;
}
.gl-tool button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 4px 10px;
  margin: 4px 0;
  background: var(--vp-c-brand-soft);
}
</style>
