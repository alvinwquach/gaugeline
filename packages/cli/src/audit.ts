import {
  AUDIT_PACK_FILES,
  auditPackFiles,
  type AuditPack,
  type CheckRegistry,
  type ServicesConfig,
  buildAuditPack,
  ConfigError,
  servicesProblem,
  type Result,
} from "@gaugeline/core";
import type { AuditFlags } from "./args.js";
import { SERVICES_CONFIG_FILE } from "./schema-config.js";
import { inspectScaffold, writeScaffold, type ScaffoldFs } from "./scaffold-write.js";

/**
 * Check where the pack would go before the site is asked anything: a folder outside this one, a link, a
 * file where the folder should be, or a pack that is already there without --force is exit 2 now and
 * not after a whole check. Reads and writes nothing.
 */
export async function checkAuditTarget(
  flags: AuditFlags,
  opts: { cwd: string; fs?: ScaffoldFs },
): Promise<void> {
  await inspectScaffold(
    AUDIT_PACK_FILES.map((name) => ({ name })),
    flags.out,
    { force: flags.force, cwd: opts.cwd, ...(opts.fs ? { fs: opts.fs } : {}) },
  );
}

/**
 * A package that names a check Gaugeline does not run is a mistake in the file, and is exit 2 before any
 * request: a quote must not promise a fix for a check that never ran.
 */
export function checkServices(config: ServicesConfig | undefined, registry: CheckRegistry): void {
  if (config === undefined) return;
  const problem = servicesProblem(config, registry);
  if (problem !== undefined)
    throw new ConfigError(`${SERVICES_CONFIG_FILE}: ${problem}.`, {
      hint: "Use the ids in the checks reference (docs/checks), or name an area instead.",
    });
}

/**
 * Turn the finished result into the pack and write it through the one safe writer (inside this folder,
 * never over a file without --force, both files or neither). Returns the pack and the paths as they
 * are shown: the folder as typed, then the file name. The command only formats: the check that made the
 * result ran before this.
 */
export async function emitAuditPack(opts: {
  flags: AuditFlags;
  result: Result;
  registry: CheckRegistry;
  services: ServicesConfig | undefined;
  probing: boolean;
  dns: boolean;
  cwd: string;
  fs?: ScaffoldFs;
}): Promise<{ pack: AuditPack; paths: string[] }> {
  const { flags } = opts;
  const pack = buildAuditPack(opts.result, opts.registry, {
    ...(flags.business !== undefined ? { business: flags.business } : {}),
    ...(opts.services ? { services: opts.services } : {}),
    brand: flags.brand,
    probing: opts.probing,
    dns: opts.dns,
  });
  await writeScaffold(auditPackFiles(pack), flags.out, {
    force: flags.force,
    cwd: opts.cwd,
    ...(opts.fs ? { fs: opts.fs } : {}),
  });
  const shown = flags.out.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return { pack, paths: AUDIT_PACK_FILES.map((name) => `${shown === "" ? "." : shown}/${name}`) };
}
