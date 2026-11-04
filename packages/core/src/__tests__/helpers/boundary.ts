import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export interface Violation {
  file: string;
  line: number;
  kind: "import-outside-package" | "imports-cli" | "process-exit" | "imports-process-exit";
  detail: string;
}

/** The lint rules in eslint.config.js encode the same boundary; keep the messages in step. */
export const LINT_RULE_NAMES = ["no-restricted-imports", "no-restricted-properties"] as const;

const CLI_PACKAGES = new Set(["gaugeline", "@gaugeline/cli"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);
const PROCESS_EXIT_NAMES = new Set(["exit", "abort", "kill", "exitCode"]);
const FORBIDDEN_CALLS = new Set(["process.exit", "process.abort", "process.kill"]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function classify(
  specifier: string,
  fromFile: string,
  packageRoot: string,
): Violation["kind"] | null {
  const bare = specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
  if (CLI_PACKAGES.has(bare)) return "imports-cli";
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return /(^|\/)packages\/cli(\/|$)/.test(specifier) ? "imports-cli" : null;
  }
  const target = resolve(dirname(fromFile), specifier);
  const rel = relative(packageRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(target) === resolve("/")) {
    return /(^|[/\\])cli([/\\]|$)/.test(rel) ? "imports-cli" : "import-outside-package";
  }
  return null;
}

/**
 * Walk every .ts file under `rootDir` (a package's src directory, skipping __tests__) and report
 * imports that leave the package, imports of the CLI, and calls to process.exit/abort/kill.
 * The package root is taken to be the parent of `rootDir`.
 */
export function findBoundaryViolations(rootDir: string): Violation[] {
  const packageRoot = dirname(resolve(rootDir));
  const violations: Violation[] = [];
  for (const file of listSourceFiles(resolve(rootDir))) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const checkSpecifier = (spec: ts.Expression | undefined, node: ts.Node) => {
      if (!spec || !ts.isStringLiteralLike(spec)) return;
      const kind = classify(spec.text, file, packageRoot);
      if (kind) violations.push({ file, line: lineOf(node), kind, detail: spec.text });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        checkSpecifier(node.moduleSpecifier, node);
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteralLike(node.moduleSpecifier) &&
          PROCESS_MODULES.has(node.moduleSpecifier.text)
        ) {
          const clause = node.importClause;
          const named =
            clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
              ? clause.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text)
              : [];
          const bad = [
            ...(clause?.name ? ["default"] : []),
            ...named.filter((n) => PROCESS_EXIT_NAMES.has(n)),
          ];
          if (bad.length > 0) {
            violations.push({
              file,
              line: lineOf(node),
              kind: "imports-process-exit",
              detail: `${bad.join(", ")} from ${node.moduleSpecifier.text}`,
            });
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        checkSpecifier(node.moduleReference.expression, node);
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          checkSpecifier(node.arguments[0], node);
        } else {
          const callee = node.expression.getText(sf).replace(/\s+/g, "").replace(/\?\./g, ".");
          if (
            FORBIDDEN_CALLS.has(callee) ||
            /^(globalThis\.)?process\.(exit|abort|kill)$/.test(callee)
          ) {
            violations.push({ file, line: lineOf(node), kind: "process-exit", detail: callee });
          }
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        checkSpecifier(node.argument.literal as ts.Expression, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

export function formatViolation(v: Violation, base: string): string {
  return `${relative(base, v.file)}:${v.line} ${v.kind} (${v.detail}); see lint rules ${LINT_RULE_NAMES.join(", ")}`;
}
