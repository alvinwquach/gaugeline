import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A GraphQL endpoint on 127.0.0.1 for the tests of `gaugeline query --graphql`: a real server on a
 * real port, which answers an introspection query sent as a GET and records every request it
 * receives (method, address, headers and body), so a test can prove that every one was a GET and
 * that no body was sent. The schema it answers with is whatever the test gives it; nothing here
 * was recorded from a real service.
 */
export interface GraphqlServerOptions {
  /** What a successful introspection answers with: the JSON body, `{ data: { __schema } }`. */
  introspection: unknown;
  /**
   * ok: answer the introspection GET.
   * disabled: answer 200 with an error, as a server with introspection turned off does.
   * get-405: answer every GET with 405 and `Allow: POST`, as a server that takes POST only does.
   */
  mode?: "ok" | "disabled" | "get-405";
  /** Answer 401 unless the request carries `Authorization: Bearer <token>`. */
  token?: string;
}

export interface SeenGraphqlRequest {
  method: string;
  /** The path and query string as sent. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface GraphqlServer {
  /** http://127.0.0.1:<port>/graphql */
  url: string;
  requests: SeenGraphqlRequest[];
  close(): Promise<void>;
}

export async function startGraphqlServer(options: GraphqlServerOptions): Promise<GraphqlServer> {
  const requests: SeenGraphqlRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const send = (status: number, body: string, extra: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", ...extra });
        res.end(body);
      };
      if (req.method !== "GET" && req.method !== "HEAD")
        return send(405, '{"errors":[{"message":"Only GET is expected here."}]}', { allow: "GET" });
      if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
        return send(401, '{"errors":[{"message":"Unauthorized"}]}');
      const mode = options.mode ?? "ok";
      if (mode === "get-405")
        return send(405, '{"errors":[{"message":"GET is not supported"}]}', { allow: "POST" });
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("query") ?? "";
      if (!query.includes("__schema"))
        return send(400, '{"errors":[{"message":"This test server only answers introspection."}]}');
      if (mode === "disabled")
        return send(200, '{"errors":[{"message":"GraphQL introspection is not allowed"}]}');
      send(200, JSON.stringify(options.introspection));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/graphql`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
