<script setup lang="ts">
import { computed, ref } from "vue";
import {
  LIVE_LIMIT,
  REDIRECT_COMMAND,
  ShapeError,
  lintRedirects,
  parseRedirectList,
  type Issue,
  type ListRow,
  type RedirectRule,
} from "../../../packages/core/src/tools/lint";

// Everything below runs in this page: the list is read here and is never uploaded or stored.
const text = ref("");
const rows = ref<ListRow[]>([]);
const issues = ref<Issue<RedirectRule>[] | null>(null);
const problem = ref("");
const domain = ref("");
const live = ref<{
  checked: number;
  skipped: number;
  findings: { line: number; title: string; evidence: string }[];
  couldNotCheck: { line: number; reason: string }[];
} | null>(null);
const liveError = ref("");
const busy = ref(false);

const LABEL: Record<RedirectRule, string> = {
  duplicate: "Duplicate",
  chain: "Chain",
  self: "Points at itself",
  "mixed-slash": "Mixed trailing slashes",
};

function check() {
  live.value = null;
  liveError.value = "";
  try {
    rows.value = parseRedirectList(text.value);
    issues.value = lintRedirects(rows.value);
    problem.value = "";
  } catch (err) {
    issues.value = null;
    rows.value = [];
    problem.value = err instanceof ShapeError ? err.message : String(err);
  }
}

async function upload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  text.value = await file.text();
  check();
}

const liveRows = computed(() => rows.value.slice(0, LIVE_LIMIT));

async function checkLive() {
  busy.value = true;
  liveError.value = "";
  live.value = null;
  try {
    const res = await fetch("/api/check-redirects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: domain.value, rows: liveRows.value }),
    });
    const body = await res.json();
    if (!res.ok) liveError.value = body.error ?? `The live check answered ${res.status}.`;
    else live.value = body;
  } catch {
    liveError.value =
      "The live check could not be reached. The full check runs locally with the command below.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="gl-tool">
    <label for="redirect-list"
      ><b>Your redirect list</b>: one per line, the old address then the new one</label
    >
    <textarea
      id="redirect-list"
      v-model="text"
      data-testid="redirect-input"
      rows="10"
      spellcheck="false"
      placeholder="From,To&#10;/old-page,/new-page"
    />
    <p>
      <label
        >Or a file (CSV or a spreadsheet's tab-separated copy):
        <input type="file" accept=".csv,.tsv,.txt" @change="upload"
      /></label>
    </p>
    <button type="button" data-testid="redirect-check" @click="check">Check the list</button>

    <div v-if="problem" class="custom-block warning" data-testid="redirect-problem">
      <p>{{ problem }}</p>
    </div>

    <div v-if="issues" data-testid="redirect-results">
      <p v-if="issues.length === 0">
        No problems in {{ rows.length }} redirect{{ rows.length === 1 ? "" : "s" }}.
      </p>
      <p v-else>
        {{ issues.length }} problem{{ issues.length === 1 ? "" : "s" }} in
        {{ rows.length }} redirect{{ rows.length === 1 ? "" : "s" }}, found in this page:
      </p>
      <ul>
        <li v-for="i in issues" :key="i.rule + i.lines.join()" :data-rule="i.rule">
          <b>{{ LABEL[i.rule] }}.</b> {{ i.message }}
        </li>
      </ul>

      <h3>Check them live (optional)</h3>
      <p>
        Requests the first {{ liveRows.length }} old addresses (at most {{ LIVE_LIMIT }}) on your
        domain, once each, and nothing on any other domain.
        <span v-if="rows.length > LIVE_LIMIT"
          >The other {{ rows.length - LIVE_LIMIT }} were checked above only.</span
        >
      </p>
      <label
        >Domain: <input v-model="domain" data-testid="redirect-domain" placeholder="yoursite.com"
      /></label>
      <button type="button" :disabled="busy || domain.trim() === ''" @click="checkLive">
        Check live
      </button>
      <div v-if="liveError" class="custom-block warning">
        <p>{{ liveError }}</p>
      </div>
      <div v-if="live">
        <p>{{ live.checked }} checked live: {{ live.findings.length }} to fix.</p>
        <ul>
          <li v-for="f in live.findings" :key="f.line + f.title">
            Line {{ f.line }}: <b>{{ f.title }}.</b> {{ f.evidence }}
          </li>
          <li v-for="c in live.couldNotCheck" :key="'c' + c.line">
            Line {{ c.line }} could not be checked: {{ c.reason }}
          </li>
        </ul>
      </div>

      <p class="gl-command">Run the full check locally:</p>
      <pre data-testid="redirect-command"><code>{{ REDIRECT_COMMAND }}</code></pre>
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
.gl-tool button,
.gl-tool input:not([type="file"]) {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 4px 10px;
  margin: 4px 4px 4px 0;
}
.gl-tool button {
  background: var(--vp-c-brand-soft);
}
</style>
