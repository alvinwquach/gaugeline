---
layout: home
title: Gaugeline docs
hero:
  name: Gaugeline
  text: Check the real page before your visitors do.
  actions:
    - theme: brand
      text: Introduction
      link: /docs/introduction
    - theme: alt
      text: Quick start
      link: /docs/quick-start
---

<script setup>
// The old docs were hash routes (#/docs/<slug>, sometimes with ?id=). Send them to /docs/<slug>.
if (typeof window !== "undefined") {
  const m = /^#\/docs\/([a-z0-9-]+)(\?[^#]*)?$/.exec(window.location.hash);
  if (m) window.location.replace(`/docs/${m[1]}${m[2] ?? ""}`);
}
</script>
