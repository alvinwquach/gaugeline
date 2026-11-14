import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the preview a host builds from a project: the bookshop's pages answer 200, a rule in the
 * project's _redirects file answers 301, anything else 404. It reads the file on every request, so the
 * copy a diff was applied to is what it serves. Listens on 127.0.0.1 only; it answers GET and HEAD alike.
 */
export function preview(
  redirectsFile: string,
  pages: readonly string[] = ["/", "/fiction", "/poetry", "/kids"],
): Promise<{ origin: string; methods: Set<string>; close: () => Promise<void> }> {
  const methods = new Set<string>();
  const server: Server = createServer((req, res) => {
    methods.add(req.method ?? "");
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const rules = new Map(
      readFileSync(redirectsFile, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "" && !l.startsWith("#"))
        .map((l) => l.trim().split(/\s+/) as [string, string]),
    );
    const to = rules.get(path);
    if (to) res.writeHead(301, { location: to }).end();
    else if (pages.includes(path))
      res.writeHead(200, { "content-type": "text/html" }).end("<title>page</title>");
    else res.writeHead(404).end("not found");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        methods,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    ),
  );
}
