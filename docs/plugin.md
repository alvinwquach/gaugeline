# Install the plugin

Hold a publish until the page is right. Coming in version 0.2.

::: warning
<b>Not released yet.</b> This page describes version 0.2, planned for about six weeks from now.
:::

```ts title=sanity.config.ts
$ npm install sanity-plugin-publish-gate

import { publishGate } from 'sanity-plugin-publish-gate'

export default defineConfig({
  // ...your existing config
  plugins: [publishGate({ site: 'https://shop.example' })],
})
```
