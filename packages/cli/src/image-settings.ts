import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ConfigError, type ImageSettings } from "@gaugeline/core";
import { IMAGES_CONFIG_FILE, readImagesJson } from "./schema-config.js";

/** A framework settings file bigger than this is not read: next.config and netlify.toml are small. */
const MAX_SETTINGS_BYTES = 256 * 1024;

/**
 * gaugeline.images.json (XF-04, ADR-0007): the framework settings files named in it are read as text
 * (never run) for the passive image checks; the owner's probe address is handed over only when
 * `consent` is true, so without consent nothing in this file can make a request.
 */
export function readImageSettings(dir: string, consent: boolean): ImageSettings | undefined {
  const config = readImagesJson(dir);
  if (!config) return undefined;
  const settings = (config.settingsFiles ?? []).map((file) => {
    const path = isAbsolute(file) ? file : resolve(dir, file);
    if (!existsSync(path) || !statSync(path).isFile())
      throw new ConfigError(
        `${IMAGES_CONFIG_FILE}: settingsFiles names ${file}, which is not a file.`,
        {
          hint: "Give the path of next.config.*, nuxt.config.*, astro.config.* or netlify.toml, relative to the folder you run from.",
        },
      );
    if (statSync(path).size > MAX_SETTINGS_BYTES)
      throw new ConfigError(
        `${IMAGES_CONFIG_FILE}: ${file} is larger than 256 KiB, so it is not read.`,
      );
    return { file, text: readFileSync(path, "utf8") };
  });
  return {
    settings,
    ...(consent && config.imageOptimizerProbeUrl
      ? { probeUrl: config.imageOptimizerProbeUrl }
      : {}),
  };
}
