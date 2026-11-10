import type { AdsEngine } from "@gaugeline/app-server";

/**
 * The ads command, as the app uses it. `gaugeline open --ads` shows what this engine returns and
 * has no second implementation of reading an export or checking its pages.
 *
 * The engine is not in this version: reading an export and grouping it by landing page is the ads
 * command (G24), and its checks follow (G24a, G24b). Until it exports its functions from
 * packages/core, this is undefined and `gaugeline open --ads` says so and exits 2. When it does,
 * this file is the one place that adapts it to AdsEngine; the app, its view and its tests need no change.
 */
export const adsEngine: AdsEngine | undefined = undefined;
