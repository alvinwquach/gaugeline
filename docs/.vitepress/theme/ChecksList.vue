<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import entries from "../../checks.data.json";

interface Entry {
  id: string;
  severity: "high" | "medium" | "low";
  area: string;
  title: string;
  what: string;
  why: string;
  fix: string;
  tech: string;
}

const LEVEL: Record<Entry["severity"], string> = {
  high: "Fix this first",
  medium: "Fix soon",
  low: "Worth knowing",
};
const checks = entries as Entry[];
/** The six areas from the report, in its order, whether or not a check is in each yet. */
const areas = [
  "Search & sharing",
  "Visitors",
  "Sales & prices",
  "Leads",
  "Security & email",
  "Launch day",
];
const area = ref("");
const open = ref<string | null>(null);
const unknown = ref<string | null>(null);
const shown = computed(() => checks.filter((c) => area.value === "" || c.area === area.value));

/** /docs/checks?id=<id> and /docs/checks#<id> open and scroll to that check. */
onMounted(async () => {
  const id =
    new URLSearchParams(window.location.search).get("id") ??
    decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  if (!checks.some((c) => c.id === id)) {
    unknown.value = id;
    return;
  }
  open.value = id;
  await nextTick();
  document.getElementById(id)?.scrollIntoView({ block: "start" });
});
</script>

<template>
  <div class="checks-list">
    <p v-if="area !== '' && shown.length === 0" class="checks-empty">No checks in this area yet.</p>
    <p v-if="unknown" class="checks-unknown">
      No check has the id "{{ unknown }}". Here is the full list.
    </p>
    <label class="checks-filter">
      Area
      <select v-model="area" aria-label="Filter by area">
        <option value="">All areas</option>
        <option v-for="a in areas" :key="a" :value="a">{{ a }}</option>
      </select>
    </label>
    <details
      v-for="c in shown"
      :id="c.id"
      :key="c.id"
      class="check"
      :data-area="c.area"
      :open="open === c.id"
    >
      <summary>
        <span :class="['level', c.severity]">{{ LEVEL[c.severity] }}</span>
        {{ c.title }} <code>{{ c.id }}</code>
      </summary>
      <p><strong>What it catches:</strong> {{ c.what }}</p>
      <p><strong>Why it matters:</strong> {{ c.why }}</p>
      <p><strong>How to fix it:</strong> {{ c.fix }}</p>
      <p>
        <strong>Technical line:</strong> <code>{{ c.tech }}</code>
      </p>
      <p class="area">Area: {{ c.area }}</p>
    </details>
  </div>
</template>

<style scoped>
.checks-filter {
  display: block;
  margin: 1rem 0;
}
.checks-filter select {
  margin-left: 0.5rem;
}
.check {
  border-top: 1px solid var(--vp-c-divider);
  padding: 0.5rem 0;
}
.check summary {
  cursor: pointer;
  font-weight: 600;
}
.level {
  font-size: 0.8em;
  margin-right: 0.5em;
  padding: 0 0.4em;
  border-radius: 4px;
}
.level.high {
  background: var(--vp-c-danger-soft);
}
.level.medium {
  background: var(--vp-c-warning-soft);
}
.level.low {
  background: var(--vp-c-default-soft);
}
.checks-unknown {
  color: var(--vp-c-warning-1);
}
</style>
