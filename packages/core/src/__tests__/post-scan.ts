import ts from "typescript";

/**
 * A TypeScript-AST scan for code that could send a request that changes something (ADR-0005,
 * ADR-0006). It reads syntax, not text, so it is not fooled by `"PO" + "ST"`, a template, a
 * computed key, a variable or a method call; its self-test (post-boundary.test.ts) runs each
 * evasion. It is a tripwire for review, not a proof: the proof is that every socket opens in
 * transport.ts and `fetcher.query()` checks every POST.
 *
 * What it reports, by category:
 * - "verb": POST, PUT, PATCH or DELETE (any case, also folded from constant pieces such as
 *   "PO" + "ST" or a template) given as the value of a method property, or kept in a variable named
 *   like a method. Comparing a method (`req.method !== "POST"`) is a server reading one.
 * - "method": a `method` / `_method` property in the options of a request-like call (`fetch`,
 *   `request`, `httpsRequest`, `new Request`...) whose value is not a GET or HEAD literal, or an
 *   assignment to a method-override header (x-http-method-override, x-original-method).
 * - "call": `.post(` `.put(` `.patch(` on anything, and `.delete(` in a file that is an HTTP client.
 * - "network": `fetch(`, `new Request(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
 *   `http.request`/`get`, `net.connect`, `new net.Socket`, and an import that brings in a client
 *   (`request` or `get` from node:http, a whole node:https, undici, axios, got...). A server that
 *   imports `createServer` is not a client.
 * - "query": `registerQueryAllow`, or `.query(url, { allow, ... })`, outside an adapter's file.
 */
export type Category = "verb" | "method" | "call" | "network" | "query";

export interface Finding {
  category: Category;
  line: number;
  what: string;
}

const VERBS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const METHOD_KEYS: ReadonlySet<string> = new Set(["method", "_method"]);
const OVERRIDE_HEADERS: ReadonlySet<string> = new Set([
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
  "x-original-method",
]);
const CLIENT_FUNCTIONS: ReadonlySet<string> = new Set([
  "request",
  "get",
  "connect",
  "createConnection",
  "Socket",
  "fetch",
  "Agent",
  "ClientRequest",
]);
const NODE_NETWORK: ReadonlySet<string> = new Set(
  ["http", "https", "http2", "net", "tls", "dgram"].flatMap((m) => [m, `node:${m}`]),
);
const NETWORK_MODULES: ReadonlySet<string> = new Set([
  ...NODE_NETWORK,
  ...[
    "undici",
    "axios",
    "got",
    "ky",
    "superagent",
    "node-fetch",
    "cross-fetch",
    "isomorphic-fetch",
    "ws",
    "request",
    "needle",
  ],
]);
const NETWORK_GLOBALS: ReadonlySet<string> = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
]);
const REQUEST_LIKE =
  /^(request|fetch|http[s]?request|send ?request|ajax|axios|got|ky|post|put|patch|delete)$/i;

/** The text of an expression made only of string constants, or undefined. */
function constText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return constText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constText(node.left);
    const r = constText(node.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const mid = constText(span.expression);
      if (mid === undefined) return undefined;
      out += mid + span.literal.text;
    }
    return out;
  }
  return undefined;
}

function nameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name)) return constText(name.expression);
  return undefined;
}

/** Does this import declaration bring in something that can open a connection as a client? */
function isClientImport(node: ts.ImportDeclaration): boolean {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return false;
  const mod = node.moduleSpecifier.text;
  if (!NETWORK_MODULES.has(mod)) return false;
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (!NODE_NETWORK.has(mod)) return true; // axios, got, undici...: any import is a client
  if (clause.name !== undefined) return true; // import http from "node:http"
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some(
    (e) => !e.isTypeOnly && CLIENT_FUNCTIONS.has((e.propertyName ?? e.name).text),
  );
}

function isGetOrHead(node: ts.Node): boolean {
  const t = constText(node);
  return t !== undefined && ["GET", "HEAD"].includes(t.toUpperCase());
}

/** The name a call is made by: `request`, `https.request`, `client.send`, `fetch`. */
function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

/** Is this object literal the options of a request-like call? */
function isRequestOptions(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    return REQUEST_LIKE.test(calleeName(parent));
  return false;
}

/** Scan one file's text. `adapterFile` / `queryFile` may register query entries and call fetcher.query(). */
export function scan(
  fileName: string,
  text: string,
  opts: { adapterFile?: boolean; queryFile?: boolean } = {},
): Finding[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Finding[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (category: Category, n: ts.Node, what: string) =>
    out.push({ category, line: line(n), what });
  const queryAllowed = opts.adapterFile === true || opts.queryFile === true;

  // Whether the file is an HTTP client (decides if `.delete(` is a request or a Map's).
  let isClient = false;
  const probe = (n: ts.Node): void => {
    if (isClient) return;
    if (ts.isImportDeclaration(n) && isClientImport(n)) isClient = true;
    if (ts.isIdentifier(n) && NETWORK_GLOBALS.has(n.text)) isClient = true;
    ts.forEachChild(n, probe);
  };
  probe(sf);

  const verbOf = (n: ts.Node): string | undefined => {
    const t = constText(n)?.trim().toUpperCase();
    return t !== undefined && VERBS.has(t) ? t : undefined;
  };

  const visit = (node: ts.Node): void => {
    // method: <value> in the options of a request-like call; the value must be a GET or HEAD literal.
    if (ts.isObjectLiteralExpression(node) && isRequestOptions(node)) {
      for (const p of node.properties) {
        const key = p.name === undefined ? undefined : nameText(p.name)?.toLowerCase();
        if (key === undefined || !METHOD_KEYS.has(key)) continue;
        const value = ts.isPropertyAssignment(p) ? p.initializer : undefined;
        if (value === undefined) add("method", p, `${key} given by a variable`);
        else if (verbOf(value) !== undefined) add("verb", p, `the method ${verbOf(value)}`);
        else if (!isGetOrHead(value)) add("method", p, `${key} is not a GET or HEAD literal`);
      }
    }
    // A verb kept in a variable or field named like a method.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (/method|verb/i.test(node.name.text) && verbOf(node.initializer) !== undefined)
        add("verb", node, `${node.name.text} = ${verbOf(node.initializer)}`);
    }
    if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
      const key = nameText(node.name)?.toLowerCase();
      const value = node.initializer;
      if (key !== undefined && value !== undefined) {
        if (
          METHOD_KEYS.has(key) &&
          verbOf(value) !== undefined &&
          !isRequestOptions(node.parent as never)
        )
          add("verb", node, `${key}: ${verbOf(value)}`);
        if (OVERRIDE_HEADERS.has(key)) add("method", node, `the header ${key}`);
      }
    }
    // headers["X-HTTP-Method-Override"] = ..., headers.set("x-original-method", ...)
    if (ts.isElementAccessExpression(node)) {
      const key = constText(node.argumentExpression)?.toLowerCase();
      if (key !== undefined && (OVERRIDE_HEADERS.has(key) || METHOD_KEYS.has(key))) {
        const assigned =
          ts.isBinaryExpression(node.parent) &&
          node.parent.left === node &&
          node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (assigned) add("method", node, `${key} is set`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      // A verb handed over as an argument: request("PUT", url), requestOnce(url, "POST", ...).
      if (/request|fetch|^(post|put|patch|delete|ajax)$/i.test(calleeName(node)))
        for (const a of node.arguments) {
          const v = verbOf(a);
          if (v !== undefined) add("verb", a, `the method ${v} passed to ${calleeName(node)}()`);
        }
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (["post", "put", "patch"].includes(name)) add("call", node, `.${name}(...)`);
        if (name === "delete" && isClient) add("call", node, ".delete(...) in an HTTP client file");
        if (
          ["request", "get", "connect", "createConnection"].includes(name) &&
          ts.isIdentifier(callee.expression) &&
          /^(https?|http2|net|tls|undici|axios|got|ky|superagent)$/i.test(callee.expression.text)
        )
          add("network", node, `${callee.expression.text}.${name}(...)`);
        if (name === "sendBeacon") add("network", node, "sendBeacon");
        if (["set", "append"].includes(name) && first !== undefined) {
          const key = constText(first)?.toLowerCase();
          if (key !== undefined && OVERRIDE_HEADERS.has(key))
            add("method", node, `the header ${key}`);
        }
        if (
          name === "query" &&
          !queryAllowed &&
          node.arguments.some(
            (a) =>
              ts.isObjectLiteralExpression(a) &&
              a.properties.some((p) => p.name !== undefined && nameText(p.name) === "allow"),
          )
        )
          add("query", node, ".query(url, { allow, ... }) outside an adapter's file");
      }
      if (ts.isIdentifier(callee)) {
        if (NETWORK_GLOBALS.has(callee.text)) add("network", node, `${callee.text}(...)`);
        if (callee.text === "require" && first !== undefined) {
          const m = constText(first);
          if (m !== undefined && NETWORK_MODULES.has(m)) add("network", node, `require of ${m}`);
        }
        if (callee.text === "registerQueryAllow" && !queryAllowed)
          add("query", node, "registerQueryAllow outside an adapter's file");
      }
      if (callee.kind === ts.SyntaxKind.ImportKeyword && first !== undefined) {
        const m = constText(first);
        if (m !== undefined && NETWORK_MODULES.has(m)) add("network", node, `import of ${m}`);
      }
    }
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (["Request", "XMLHttpRequest", "WebSocket", "EventSource", "Socket"].includes(name))
        add("network", node, `new ${name}(...)`);
    }
    if (ts.isImportDeclaration(node) && isClientImport(node))
      add("network", node, `import of ${(node.moduleSpecifier as ts.StringLiteral).text}`);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      NETWORK_MODULES.has(node.moduleReference.expression.text)
    )
      add("network", node, `import of ${node.moduleReference.expression.text}`);
    if (
      ts.isIdentifier(node) &&
      node.text === "registerQueryAllow" &&
      !queryAllowed &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent)
    )
      add("query", node, "registerQueryAllow named outside an adapter's file");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
