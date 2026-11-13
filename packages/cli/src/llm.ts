import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  ByokError,
  ConfigError,
  MAX_LLM_CONFIG_CHARS,
  LLM_CONFIG_FILE,
  describeByok,
  readByokConfig,
  renderByokStatus,
  type Outcome,
} from "@gaugeline/core";

interface Out {
  stdout: { write(s: string): unknown };
}

/**
 * gaugeline llm (AG-20): check a model setup with the person's own key (ADR-0005, mode 1). It reads one
 * settings file and the one environment variable that file names, and prints what is set up and whether that
 * variable holds a usable key, never the key. It makes no request and calls no model. Exit 0 when it ran (also
 * when the key is not set: that is an answer, not a failure), 2 (a ConfigError) when the file is missing, too
 * large or not valid.
 */
export function runLlm(
  args: { llmConfig?: string; json: boolean },
  io: Out,
  deps: { cwd: string; env: Readonly<Record<string, string | undefined>> },
): Outcome {
  const typed = args.llmConfig ?? LLM_CONFIG_FILE;
  const path = resolve(deps.cwd, typed);
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new ConfigError(`${typed} is not a file.`);
    if (st.size > MAX_LLM_CONFIG_CHARS * 4)
      throw new ConfigError(`${typed} is larger than ${MAX_LLM_CONFIG_CHARS} characters.`);
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Could not read ${typed}.`, {
      hint: `Make a file ${LLM_CONFIG_FILE} with a provider, a model for each tier and keyEnv: the name of the variable that holds your key.`,
      cause: e,
    });
  }
  let status;
  try {
    status = describeByok(readByokConfig(text, deps.env), deps.env, "cli");
  } catch (e) {
    if (e instanceof ByokError)
      throw new ConfigError(e.message.replace(LLM_CONFIG_FILE, typed), {
        hint: "The file names the variable that holds your key. It never holds the key.",
        cause: e,
      });
    throw e;
  }
  io.stdout.write(
    args.json ? `${JSON.stringify(status, null, 2)}\n` : `${renderByokStatus(status)}\n`,
  );
  return { kind: "ran", highFindings: 0, drift: false };
}
