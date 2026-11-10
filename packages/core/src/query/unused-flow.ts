import type * as TS from "typescript";
import type { QueryState, TreeNode } from "./unused-trees.js";
import type { TypeScript } from "./source.js";

/**
 * Follow the result of one query through the code, with the TypeScript compiler's symbols: the
 * variable it is assigned to, `await`, destructuring, props passed to components, `map` callbacks,
 * returns and spreads into JSX props. Every property read, destructured name or element access
 * marks the matching node of the query's field tree as read. Where the result goes somewhere the
 * walk cannot open (JSON.stringify, a function from a package, a name only known at run time) it
 * says so instead of guessing: a whole query is "could not follow" when its own result escapes, and
 * a nested object that escapes counts as read, with everything inside it.
 *
 * Reads only: this file never touches the file system, the network or the environment. The
 * compiler's program is built by unused.ts and handed in.
 */

/** What is known about a value at one place in the code. */
type Value =
  | { k: "node"; node: TreeNode; list: boolean | "maybe" }
  /** `{ data, ...}` from sanityFetch, useQuery and the like: only `data` is the result. */
  | { k: "wrap"; node: TreeNode; list: boolean | "maybe" }
  /** An object (props, a literal, a spread) or an array literal (`tuple`) that holds tracked values. */
  | { k: "bag"; members: Map<string, Value>; spreads: Value[]; tuple: boolean };

/** Calls whose result is the query's result itself. */
const DIRECT = new Set(["fetch", "request"]);
/** Calls whose result holds the query's result in `data`. */
const WRAPPED = new Set([
  "sanityFetch",
  "loadQuery",
  "useQuery",
  "useLazyQuery",
  "useSuspenseQuery",
  "useLiveQuery",
  "query",
  "rawRequest",
]);
/** Functions that hand their argument back as the function (`memo(Card)`, `cache(async () => ...)`). */
const WRAPPERS = new Set([
  "memo",
  "forwardRef",
  "cache",
  "unstable_cache",
  "observer",
  "useCallback",
]);
/** `defineQuery(groq`...`)` is the same query. */
const QUERY_WRAPPERS = new Set(["defineQuery"]);
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);
/** The most places one result is followed to before the query is given up on. */
const STEP_LIMIT = 20_000;

type FnLike =
  TS.ArrowFunction | TS.FunctionExpression | TS.FunctionDeclaration | TS.MethodDeclaration;

export class Flow {
  /** Identifiers by the declaration of the symbol they refer to (an exported name has two symbols and one declaration). */
  private refs: Map<TS.Node, TS.Identifier[]> | null = null;
  private readonly nodeIds = new Map<TS.Node, number>();
  private query!: QueryState;
  private seen = new Set<string>();
  private steps = 0;
  private stopped = false;

  constructor(
    private readonly ts: TypeScript,
    private readonly checker: TS.TypeChecker,
    private readonly program: TS.Program,
    /** A file name as the person sees it: relative to the folder that was read, with "/". */
    private readonly rel: (fileName: string) => string,
  ) {}

  /** Follow `query` from the expression that holds it (the template, or the defineQuery call). */
  follow(query: QueryState, anchor: TS.Node): void {
    this.query = query;
    this.seen = new Set();
    this.steps = 0;
    this.stopped = false;
    this.queryFlow(anchor);
  }

  // -------------------------------------------------------------------------------------------
  // Symbols and references

  private declarationOf(sym: TS.Symbol): TS.Node | undefined {
    return sym.valueDeclaration ?? sym.declarations?.[0];
  }

  private id(sym: TS.Symbol): number {
    const d = this.declarationOf(sym);
    return d ? this.nodeId(d) : 0;
  }

  private nodeId(node: TS.Node): number {
    let n = this.nodeIds.get(node);
    if (n === undefined) {
      n = this.nodeIds.size + 1;
      this.nodeIds.set(node, n);
    }
    return n;
  }

  /** The symbol a name refers to, through imports and re-exports to where it is declared. */
  private symbolAt(node: TS.Node): TS.Symbol | undefined {
    const ts = this.ts;
    try {
      let sym =
        node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
          : this.checker.getSymbolAtLocation(node);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.checker.getAliasedSymbol(sym);
      return sym;
    } catch {
      return undefined;
    }
  }

  /** Every identifier in the program, grouped by the symbol it refers to. Built once, on first use. */
  private references(sym: TS.Symbol | undefined): TS.Identifier[] {
    const declaration = sym ? this.declarationOf(sym) : undefined;
    if (!declaration) return [];
    if (this.refs === null) {
      const ts = this.ts;
      const refs = new Map<TS.Node, TS.Identifier[]>();
      const visit = (node: TS.Node): void => {
        if (ts.isIdentifier(node) && !this.notAReference(node)) {
          const s = this.symbolAt(node);
          const d = s ? this.declarationOf(s) : undefined;
          if (d) {
            const list = refs.get(d);
            if (list) list.push(node);
            else refs.set(d, [node]);
          }
        }
        ts.forEachChild(node, visit);
      };
      for (const sf of this.program.getSourceFiles()) if (!sf.isDeclarationFile) visit(sf);
      this.refs = refs;
    }
    return this.refs.get(declaration) ?? [];
  }

  /** Names that declare something, import or export it, or sit in a type: none of them reads a value. */
  private notAReference(id: TS.Identifier): boolean {
    const ts = this.ts;
    const p = id.parent;
    if (!p) return true;
    if (
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isExportSpecifier(p) ||
      ts.isExportAssignment(p) ||
      ts.isImportEqualsDeclaration(p) ||
      ts.isTypeNode(p) ||
      ts.isQualifiedName(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isLabeledStatement(p)
    )
      return true;
    if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id;
    if (
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isJsxAttribute(p) ||
      ts.isEnumMember(p)
    )
      return p.name === id;
    return false;
  }

  /** `a.b` is the reference when the name is the `b` of it (a property or a namespace member). */
  private exprOf(id: TS.Identifier): TS.Expression {
    const p = id.parent;
    return this.ts.isPropertyAccessExpression(p) && p.name === id ? p : id;
  }

  // -------------------------------------------------------------------------------------------
  // Words for the reasons

  private at(node: TS.Node): string {
    const sf = node.getSourceFile();
    return `${this.rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  }

  private calleeText(expr: TS.Expression): string {
    const ts = this.ts;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr))
      return `${this.calleeText(expr.expression)}.${expr.name.text}`;
    return "a function";
  }

  private couldNot(reason: string): void {
    if (this.query.couldNot === null) this.query.couldNot = reason;
  }

  // -------------------------------------------------------------------------------------------
  // From the query to the call that runs it

  private skipWrappers(from: TS.Node, queryWrappers: boolean): TS.Node {
    const ts = this.ts;
    let n = from;
    for (;;) {
      const p = n.parent;
      if (!p) return n;
      if (
        ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isTypeAssertionExpression(p)
      )
        n = p;
      else if (
        queryWrappers &&
        ts.isCallExpression(p) &&
        p.arguments[0] === n &&
        QUERY_WRAPPERS.has(this.calleeText(p.expression).split(".").pop() ?? "")
      )
        n = p;
      else return n;
    }
  }

  private queryFlow(from: TS.Node): void {
    if (this.stopped) return;
    const ts = this.ts;
    const n = this.skipWrappers(from, true);
    const p = n.parent;
    if (!p) return this.couldNot("it is not used in a way Gaugeline can follow");
    if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name))
      return this.queryOfSymbol(this.symbolAt(p.name), p);
    if (ts.isCallExpression(p) && p.expression !== n) {
      const index = p.arguments.indexOf(n as TS.Expression);
      if (index >= 0) return this.queryCall(p, index);
    }
    const named =
      (ts.isPropertyAssignment(p) && p.initializer === n) ||
      (ts.isShorthandPropertyAssignment(p) && p.name === n);
    if (named) {
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "";
      const literal = p.parent;
      const call = literal?.parent;
      // sanityFetch({ query: QUERY, params }): the query is a property of the one argument.
      if (
        key === "query" &&
        literal &&
        ts.isObjectLiteralExpression(literal) &&
        call &&
        ts.isCallExpression(call)
      )
        return this.queryCall(call, -1);
      if (ts.isPropertyAssignment(p)) return this.queryOfSymbol(this.symbolAt(p.name), p);
    }
    return this.couldNot(`it is used in a way Gaugeline cannot follow (${this.at(p)})`);
  }

  private queryOfSymbol(sym: TS.Symbol | undefined, at: TS.Node): void {
    if (!sym) return this.couldNot(`it is used in a way Gaugeline cannot follow (${this.at(at)})`);
    const key = `q|${this.id(sym)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const refs = this.references(sym);
    if (refs.length === 0) return this.couldNot("nothing in the code that was read uses it");
    for (const ref of refs) this.queryFlow(this.exprOf(ref));
  }

  private queryCall(call: TS.CallExpression, index: number): void {
    const ts = this.ts;
    const name = this.calleeText(call.expression);
    const last = name.split(".").pop() ?? name;
    const fn = this.functionOf(call.expression);
    if (fn) {
      const param = index >= 0 ? fn.parameters[index] : undefined;
      if (param && ts.isIdentifier(param.name))
        return this.queryOfSymbol(this.symbolAt(param.name), call);
      return this.couldNot(
        `it is passed to ${name}, whose parameter Gaugeline cannot follow (${this.at(call)})`,
      );
    }
    const member = ts.isPropertyAccessExpression(call.expression);
    // client.fetch(...) and request(...); a bare fetch(...) is the browser's and takes an address first.
    if (DIRECT.has(last) && (member || last !== "fetch")) return this.flow(call, this.root("node"));
    if (WRAPPED.has(last)) return this.flow(call, this.root("wrap"));
    return this.couldNot(
      `it is passed to ${name}, which Gaugeline cannot read into (${this.at(call)})`,
    );
  }

  private root(kind: "node" | "wrap"): Value {
    return { k: kind, node: this.query.root, list: this.query.root.list };
  }

  // -------------------------------------------------------------------------------------------
  // Values

  private sig(v: Value): string {
    if (v.k === "bag")
      return `{${[...v.members]
        .map(([k, x]) => `${k}=${this.sig(x)}`)
        .sort()
        .join(",")}|${v.spreads.map((s) => this.sig(s)).join(",")}${v.tuple ? "t" : ""}}`;
    return `${v.k}${v.node.id}:${String(v.list)}`;
  }

  private bagOf(key: string, v: Value, tuple = false): Value {
    return { k: "bag", members: new Map([[key, v]]), spreads: [], tuple };
  }

  /** The value of `v.name`, or null when nothing tracked is there. Marks a field read. */
  private member(v: Value, name: string): Value | null {
    if (v.k === "bag") return v.members.get(name) ?? null;
    if (v.k === "wrap") return name === "data" ? { k: "node", node: v.node, list: v.list } : null;
    if (v.list === true) return null;
    const child = v.node.children.get(name);
    if (!child) return null;
    child.used = true;
    return { k: "node", node: child, list: child.list };
  }

  private mark(node: TreeNode): void {
    node.used = true;
    for (const c of node.children.values()) this.mark(c);
  }

  /** The value goes where Gaugeline cannot follow it. */
  private escape(v: Value, why: string, at: TS.Node): void {
    if (v.k === "bag") {
      for (const m of v.members.values()) this.escape(m, why, at);
      for (const s of v.spreads) this.escape(s, why, at);
      return;
    }
    if (v.node === this.query.root) this.couldNot(`${why} (${this.at(at)})`);
    else this.mark(v.node);
  }

  /** The value is read as a whole. Fine for a field with nothing inside it, an escape for an object. */
  private asValue(v: Value, at: TS.Node): void {
    if (v.k === "node" && v.node.children.size === 0 && v.node !== this.query.root) return;
    this.escape(v, "its result is used as a whole value", at);
  }

  private dynamic(at: TS.Node): void {
    this.couldNot(`a field is read by a name only known at run time (${this.at(at)})`);
  }

  private elementOf(v: Value & { k: "node" }): Value {
    return { k: "node", node: v.node, list: false };
  }

  private listOf(v: Value & { k: "node" }): Value {
    return { k: "node", node: v.node, list: true };
  }

  private spreadOf(v: Value, at: TS.Node): Value {
    if (v.k === "bag")
      return { k: "bag", members: new Map(v.members), spreads: [...v.spreads], tuple: v.tuple };
    const members = new Map<string, Value>();
    if (v.k === "node" && v.list !== true)
      for (const [key, c] of v.node.children)
        members.set(key, { k: "node", node: c, list: c.list });
    else this.escape(v, "its result is spread into an object", at);
    return { k: "bag", members, spreads: [v], tuple: false };
  }

  // -------------------------------------------------------------------------------------------
  // Where a value goes

  private flow(start: TS.Node, v: Value): void {
    if (this.stopped) return;
    if (++this.steps > STEP_LIMIT) {
      this.couldNot("its result goes through more code than Gaugeline will follow");
      this.stopped = true;
      return;
    }
    const ts = this.ts;
    let n = start;
    while (
      n.parent &&
      (ts.isParenthesizedExpression(n.parent) ||
        ts.isAsExpression(n.parent) ||
        ts.isNonNullExpression(n.parent) ||
        ts.isSatisfiesExpression(n.parent) ||
        ts.isTypeAssertionExpression(n.parent) ||
        ts.isAwaitExpression(n.parent))
    )
      n = n.parent;
    const p = n.parent;
    if (!p) return;

    if (ts.isPropertyAccessExpression(p) && p.expression === n)
      return this.access(p, p.name.text, v);
    if (ts.isElementAccessExpression(p) && p.expression === n) return this.element(p, v);
    if (ts.isVariableDeclaration(p) && p.initializer === n) return this.bind(p.name, v, p);
    if (ts.isBinaryExpression(p)) return this.binary(p, n, v);
    if (ts.isPrefixUnaryExpression(p) || ts.isTypeOfExpression(p) || ts.isVoidExpression(p)) return;
    if (ts.isConditionalExpression(p)) return p.condition === n ? undefined : this.flow(p, v);
    if (
      (ts.isIfStatement(p) ||
        ts.isWhileStatement(p) ||
        ts.isDoStatement(p) ||
        ts.isSwitchStatement(p) ||
        ts.isCaseClause(p)) &&
      p.expression === n
    )
      return;
    if (ts.isForStatement(p) && p.condition === n) return;
    if (ts.isExpressionStatement(p)) return;
    if (ts.isReturnStatement(p)) {
      const fn = ts.findAncestor(p, ts.isFunctionLike);
      return fn
        ? this.returned(fn, v, p)
        : this.escape(v, "its result is returned from the top of a file", p);
    }
    if (ts.isArrowFunction(p) && p.body === n) return this.returned(p, v, p);
    if (ts.isCallExpression(p)) {
      if (p.expression === n) return this.escape(v, "its result is called as a function", p);
      return this.argument(p, n, v);
    }
    if (ts.isNewExpression(p))
      return this.escape(v, `its result is passed to ${p.expression.getText()}`, p);
    if (ts.isJsxExpression(p)) {
      const g = p.parent;
      return g && ts.isJsxAttribute(g) ? this.jsxAttribute(g, v) : this.asValue(v, p);
    }
    if (ts.isJsxSpreadAttribute(p)) return this.jsxSpread(p, v);
    if (ts.isPropertyAssignment(p) && p.initializer === n) {
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key === null)
        return this.escape(v, "its result is put in an object under a computed name", p);
      return this.flow(p.parent, this.bagOf(key, v));
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name === n)
      return this.flow(p.parent, this.bagOf(p.name.text, v));
    if (ts.isSpreadAssignment(p)) return this.flow(p.parent, this.spreadOf(v, p));
    if (ts.isArrayLiteralExpression(p)) {
      const i = p.elements.indexOf(n as TS.Expression);
      if (i < 0 || p.elements.slice(0, i).some((e) => ts.isSpreadElement(e)))
        return this.escape(v, "its result is put in an array", p);
      return this.flow(p, this.bagOf(String(i), v, true));
    }
    if (ts.isSpreadElement(p)) {
      const array = p.parent;
      if (
        v.k === "node" &&
        v.list !== false &&
        ts.isArrayLiteralExpression(array) &&
        array.elements.length === 1
      )
        return this.flow(array, this.listOf(v));
      return this.escape(v, "its result is spread into an argument or an array", p);
    }
    if (ts.isForOfStatement(p) && p.expression === n) {
      const init = p.initializer;
      if (
        v.k === "node" &&
        v.list !== false &&
        ts.isVariableDeclarationList(init) &&
        init.declarations[0]
      )
        return this.bind(init.declarations[0].name, this.elementOf(v), p);
      return this.escape(v, "its result is looped over in a way Gaugeline cannot follow", p);
    }
    if (ts.isTemplateSpan(p)) return this.asValue(v, p);
    if (ts.isTypeQueryNode(p) || ts.isTypeNode(p)) return;
    return this.escape(v, "its result is used in a way Gaugeline cannot follow", p);
  }

  private binary(p: TS.BinaryExpression, n: TS.Node, v: Value): void {
    const ts = this.ts;
    const K = ts.SyntaxKind;
    switch (p.operatorToken.kind) {
      case K.EqualsToken:
      case K.QuestionQuestionEqualsToken:
      case K.BarBarEqualsToken:
      case K.AmpersandAmpersandEqualsToken: {
        if (p.right !== n) return; // the left side is written, not read
        let left: TS.Expression = p.left;
        while (ts.isParenthesizedExpression(left)) left = left.expression;
        if (ts.isIdentifier(left)) {
          const sym = this.symbolAt(left);
          if (sym) return this.track(sym, v);
        }
        return this.escape(v, "its result is assigned to something Gaugeline cannot follow", p);
      }
      case K.QuestionQuestionToken:
      case K.BarBarToken:
        return this.flow(p, v);
      case K.AmpersandAmpersandToken:
        return p.right === n ? this.flow(p, v) : undefined;
      case K.EqualsEqualsToken:
      case K.EqualsEqualsEqualsToken:
      case K.ExclamationEqualsToken:
      case K.ExclamationEqualsEqualsToken:
      case K.LessThanToken:
      case K.LessThanEqualsToken:
      case K.GreaterThanToken:
      case K.GreaterThanEqualsToken:
      case K.InstanceOfKeyword:
      case K.InKeyword:
        return;
      default:
        return this.asValue(v, p);
    }
  }

  private access(expr: TS.Expression, name: string, v: Value): void {
    if (v.k === "bag") {
      if (v.tuple && name !== "length")
        return this.escape(v, "an array holding its result is read", expr);
      const m = this.member(v, name);
      if (m) this.flow(expr, m);
      return;
    }
    const call = expr.parent;
    const called = this.ts.isCallExpression(call) && call.expression === expr;
    if (PROMISE_METHODS.has(name) && called) return this.callback(call, 0, [0], v);
    if (v.k === "wrap") {
      const m = this.member(v, name);
      if (m) this.flow(expr, m);
      return;
    }
    // A name the query projects is a field; with a list it is an array method.
    const isField = v.list !== true && v.node.children.has(name);
    if (v.list !== false && !isField) return this.arrayMethod(expr, name, v);
    const m = this.member(v, name);
    if (m) this.flow(expr, m);
  }

  private arrayMethod(expr: TS.Expression, name: string, v: Value & { k: "node" }): void {
    if (name === "length") return;
    const call = expr.parent;
    if (!this.ts.isCallExpression(call) || call.expression !== expr)
      return this.escape(v, `its result's ${name} is used as a value`, expr);
    const elem = this.elementOf(v);
    const list = this.listOf(v);
    switch (name) {
      case "map":
      case "forEach":
      case "flatMap":
      case "some":
      case "every":
      case "findIndex":
      case "findLastIndex":
        return this.callback(call, 0, [0], elem);
      case "filter":
        this.callback(call, 0, [0], elem);
        return this.flow(call, list);
      case "find":
      case "findLast":
        this.callback(call, 0, [0], elem);
        return this.flow(call, elem);
      case "sort":
      case "toSorted":
        this.callback(call, 0, [0, 1], elem);
        return this.flow(call, list);
      case "reduce":
      case "reduceRight":
        return this.callback(call, 0, [1], elem);
      case "slice":
      case "reverse":
      case "toReversed":
        return this.flow(call, list);
      case "at":
        return this.flow(call, elem);
      case "includes":
      case "indexOf":
      case "lastIndexOf":
        return;
      default:
        return this.escape(v, `its result is passed to .${name}()`, call);
    }
  }

  /** `array.map(callback)`: the value is what the callback's parameters at `params` receive. */
  private callback(call: TS.CallExpression, arg: number, params: number[], v: Value): void {
    const ts = this.ts;
    let fn: FnLike | null = null;
    let a = call.arguments[arg];
    if (!a) return;
    while (ts.isParenthesizedExpression(a)) a = a.expression;
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) fn = a;
    else if (ts.isIdentifier(a) && a.text === "Boolean") return;
    else if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) fn = this.functionOf(a);
    if (!fn)
      return this.escape(v, "its result is handed to a function Gaugeline cannot open", call);
    for (const i of params) {
      const param = fn.parameters[i];
      if (!param) continue;
      if (param.dotDotDotToken)
        this.escape(v, "its result is collected into a rest parameter", param);
      else this.bind(param.name, v, param);
    }
  }

  private element(p: TS.ElementAccessExpression, v: Value): void {
    const ts = this.ts;
    const arg = p.argumentExpression;
    if (ts.isStringLiteralLike(arg)) return this.access(p, arg.text, v);
    if (v.k === "bag") {
      if (ts.isNumericLiteral(arg)) {
        const m = this.member(v, arg.text);
        if (m) this.flow(p, m);
        return;
      }
      return this.dynamic(p);
    }
    if (v.k === "node" && v.list === true) return this.flow(p, this.elementOf(v));
    if (v.k === "node" && v.list === "maybe" && ts.isNumericLiteral(arg))
      return this.flow(p, this.elementOf(v));
    this.dynamic(p);
  }

  /** Give a value to the names that receive it: a variable, a destructuring pattern, a parameter. */
  private bind(name: TS.BindingName, v: Value, at: TS.Node): void {
    const ts = this.ts;
    if (ts.isIdentifier(name)) {
      const sym = this.symbolAt(name);
      if (!sym) return this.escape(v, "its result is stored where Gaugeline cannot follow it", at);
      return this.track(sym, v);
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        if (el.dotDotDotToken) {
          this.escape(v, "its result is collected with a rest pattern", el);
          continue;
        }
        const key = this.keyOf(el.propertyName ?? el.name);
        if (key === null) {
          this.dynamic(el);
          continue;
        }
        const m = v.k === "node" && v.list === true ? null : this.member(v, key);
        if (m) this.bind(el.name, m, el);
      }
      return;
    }
    // [a, b] = list or tuple
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      if (v.k === "node" && v.list !== false)
        return this.bind(el.name, el.dotDotDotToken ? this.listOf(v) : this.elementOf(v), el);
      if (v.k === "bag" && v.tuple && !el.dotDotDotToken) {
        const m = this.member(v, String(i));
        if (m) this.bind(el.name, m, el);
        return;
      }
      this.escape(v, "its result is taken apart by position", el);
    });
  }

  private keyOf(name: TS.PropertyName | TS.BindingName): string | null {
    const ts = this.ts;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
      return name.expression.text;
    return null;
  }

  /** Follow every use of a variable or parameter. */
  private track(sym: TS.Symbol, v: Value): void {
    const key = `${this.id(sym)}|${this.sig(v)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    for (const ref of this.references(sym)) this.flow(this.exprOf(ref), v);
  }

  // -------------------------------------------------------------------------------------------
  // Functions

  private unparen(e: TS.Expression): TS.Expression {
    const ts = this.ts;
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur)
    )
      cur = cur.expression;
    return cur;
  }

  private fnIn(e: TS.Expression | undefined, depth = 0): FnLike | null {
    const ts = this.ts;
    if (!e) return null;
    const x = this.unparen(e);
    if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return x;
    // memo(Card): the function is the one `Card` names.
    if (depth < 3 && (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)))
      return this.functionOf(x, depth + 1);
    if (
      ts.isCallExpression(x) &&
      WRAPPERS.has(this.calleeText(x.expression).split(".").pop() ?? "")
    )
      return this.fnIn(x.arguments[0], depth);
    return null;
  }

  /** The function a name refers to, when the program declares one with a body. */
  private functionOf(expr: TS.Expression, depth = 0): FnLike | null {
    const ts = this.ts;
    const target = ts.isPropertyAccessExpression(expr)
      ? expr.name
      : ts.isIdentifier(expr)
        ? expr
        : null;
    if (!target) return this.fnIn(expr, depth);
    for (const d of this.symbolAt(target)?.declarations ?? []) {
      if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body) return d;
      const init =
        ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)
          ? d.initializer
          : ts.isExportAssignment(d)
            ? d.expression
            : undefined;
      const f = this.fnIn(init, depth);
      if (f) return f;
    }
    return null;
  }

  /** The symbol a function is known by: its own name, or the variable or property it is assigned to. */
  private nameOfFunction(fn: TS.Node): TS.Symbol | undefined {
    const ts = this.ts;
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name)
      return this.symbolAt(fn.name);
    let n: TS.Node = fn;
    for (;;) {
      const p = n.parent;
      if (!p) return undefined;
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))
        n = p;
      else if (
        ts.isCallExpression(p) &&
        p.arguments[0] === n &&
        WRAPPERS.has(this.calleeText(p.expression).split(".").pop() ?? "")
      )
        n = p;
      else if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name))
        return this.symbolAt(p.name);
      else if (ts.isPropertyAssignment(p) && p.initializer === n) return this.symbolAt(p.name);
      else return undefined;
    }
  }

  /** The value is returned from `fn`: it reaches every call of it. */
  private returned(fn: TS.Node, v: Value, at: TS.Node): void {
    const ts = this.ts;
    const sym = this.nameOfFunction(fn);
    const name = sym?.getName() ?? "a function";
    if (!sym)
      return this.escape(v, "its result is returned from a function Gaugeline cannot trace", at);
    const key = `r|${this.nodeId(fn)}|${this.sig(v)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const refs = this.references(sym);
    if (refs.length === 0)
      return this.escape(
        v,
        `its result is returned from ${name}, which nothing in the code calls`,
        at,
      );
    for (const ref of refs) {
      const e = this.exprOf(ref);
      const call = e.parent;
      if (call && ts.isCallExpression(call) && call.expression === e) this.flow(call, v);
      else this.escape(v, `${name}, which returns its result, is used as a value`, e);
    }
  }

  /** The value is argument `n` of `call`: it becomes the parameter of the function called. */
  private argument(call: TS.CallExpression, n: TS.Node, v: Value): void {
    const ts = this.ts;
    const text = this.calleeText(call.expression);
    const i = call.arguments.indexOf(n as TS.Expression);
    if (text === "Promise.all" && v.k === "bag" && v.tuple) return this.flow(call, v);
    if (text === "Array.isArray" || text === "Boolean") return;
    const fn =
      i < 0 || call.arguments.slice(0, i + 1).some((a) => ts.isSpreadElement(a))
        ? null
        : this.functionOf(call.expression);
    if (!fn)
      return this.escape(
        v,
        `its result is passed to ${text}, which Gaugeline cannot read into`,
        call,
      );
    const param = fn.parameters[i];
    if (!param) return;
    if (param.dotDotDotToken)
      return this.escape(v, `its result is collected by ${text}'s rest parameter`, call);
    this.bind(param.name, v, param);
  }

  // -------------------------------------------------------------------------------------------
  // JSX props

  private component(tag: TS.JsxTagNameExpression): FnLike | null {
    const ts = this.ts;
    if (ts.isIdentifier(tag)) return /^[A-Z]/.test(tag.text) ? this.functionOf(tag) : null;
    if (ts.isPropertyAccessExpression(tag)) return this.functionOf(tag);
    return null;
  }

  private jsxAttribute(attr: TS.JsxAttribute, v: Value): void {
    const ts = this.ts;
    const opening = attr.parent.parent;
    const fn = ts.isIdentifier(attr.name) ? this.component(opening.tagName) : null;
    const props = fn?.parameters[0];
    if (!fn || !ts.isIdentifier(attr.name)) return this.asValue(v, attr);
    if (!props) return;
    this.bind(props.name, this.bagOf(attr.name.text, v), attr);
  }

  private jsxSpread(p: TS.JsxSpreadAttribute, v: Value): void {
    const opening = p.parent.parent;
    const fn = this.component(opening.tagName);
    const props = fn?.parameters[0];
    if (!fn)
      return this.escape(v, "its result is spread into a component Gaugeline cannot open", p);
    if (props) this.bind(props.name, this.spreadOf(v, p), p);
  }
}
