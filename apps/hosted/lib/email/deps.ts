/** The preference page's dependencies for a running server: the shared connection and the token secret. */
import { getDeps } from "../api/deps.js";
import type { PreferenceDeps } from "./preferences.js";
import { checkTokenSecret, TOKEN_SECRET_ENV } from "./token.js";

export async function getPreferenceDeps(): Promise<PreferenceDeps> {
  const { sql } = await getDeps();
  return { sql, tokenSecret: checkTokenSecret(process.env[TOKEN_SECRET_ENV]) };
}
