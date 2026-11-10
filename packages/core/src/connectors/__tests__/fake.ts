import type { Fetcher } from "../../fetcher.js";
import { isConfigured } from "../env.js";
import type { Connector, Env } from "../types.js";

/** A connector with no network of its own: `read` is whatever the test passes. */
export function fake<T>(
  id: string,
  envVars: string[],
  read: (env: Env, fetcher: Fetcher) => Promise<T[]>,
): Connector<T> {
  return { id, envVars, configured: (env) => isConfigured(env, envVars), read };
}

/** Key-shaped test values, built at run time so no secret scanner sees a literal. */
export function testKey(label: string): string {
  return ["rk", "test", label, "0123456789abcdefghij"].join("_");
}
