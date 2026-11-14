import { connect } from "node:net";
import { startApp } from "../../server.js";
import { testClientDir } from "./client.js";

/** One raw HTTP/1.1 request: headers exactly as given, the body optional, the reply parsed. */
export function raw(
  port: number,
  lines: string[],
  body = "",
): Promise<{ status: number; head: string; body: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port }, () =>
      c.write(
        `${lines.join("\r\n")}\r\nConnection: close\r\n${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`,
      ),
    );
    const chunks: Buffer[] = [];
    c.on("data", (d: Buffer) => chunks.push(d));
    c.on("end", () => {
      const all = Buffer.concat(chunks);
      const i = all.indexOf("\r\n\r\n");
      const head = all.subarray(0, i).toString("utf8");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0),
        head,
        body: all.subarray(i + 4).toString("utf8"),
        bytes: all.subarray(i + 4),
      });
    });
    c.on("error", reject);
  });
}

/** The value of one response header in a raw head, or undefined. All values joined when repeated. */
export function header(head: string, name: string): string | undefined {
  const values = head
    .split("\r\n")
    .slice(1)
    .filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    .map((l) => l.slice(name.length + 1).trim());
  return values.length === 0 ? undefined : values.join(", ");
}

/** The app, with its link opened: a client holding the session, as the browser would. */
export async function client(opts: Parameters<typeof startApp>[0] = {}) {
  const app = await startApp({ clientDir: testClientDir(), ...opts });
  const host = `localhost:${app.port}`;
  const link = await raw(app.port, [`GET /${new URL(app.url).search} HTTP/1.1`, `Host: ${host}`]);
  const cookie = /^set-cookie: ([^;]+)/im.exec(link.head)?.[1] ?? "";
  const base = [`Host: ${host}`, `Cookie: ${cookie}`, `Origin: http://${host}`];
  const call = async (method: string, path: string, body?: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const r = await raw(
      app.port,
      [`${method} ${path} HTTP/1.1`, ...base, ...(text ? ["Content-Type: application/json"] : [])],
      text,
    );
    return { ...r, json: () => JSON.parse(r.body) as Record<string, unknown> };
  };
  const finished = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const r = (await call("GET", `/api/runs/${id}`)).json();
      if (r.state !== "running") return r;
      await new Promise((t) => setTimeout(t, 25));
    }
    throw new Error("the run did not finish");
  };
  return { app, call, finished, host, cookie, base };
}
