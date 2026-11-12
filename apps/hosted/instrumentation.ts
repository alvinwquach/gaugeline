import { getDeps } from "./lib/api/deps.js";

/** Runs once when the server starts: a database login that skips row-level security stops it here. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") await getDeps();
}
