import { spawn } from "node:child_process";

/**
 * Open a file in the default browser, without waiting and without failing the run: macOS open,
 * Windows start, everything else xdg-open. A missing opener is ignored.
 */
export function openInBrowser(path: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', path]]
        : ["xdg-open", [path]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no opener on this machine: the report is still written
  }
}
