import { useId, useState } from "react";
import { CHECK_TITLES } from "../check-titles";
import { formatHash } from "../route";
import { blockTitle, toTree, type Node } from "../search/tree";
import type { RunState } from "../store";
import type { PageData, StructuredBlock } from "../types";
import { RunNotice } from "./RunNotice";

/** The finding that explains a page with almost nothing to read. */
const THIN_PAGE_CHECK = "thin-html";
/** Levels shown open when a block is drawn; deeper ones start closed. */
const OPEN_LEVELS = 3;

/**
 * What the checked page declares, as read without JavaScript: its title, canonical, readable words
 * and structured data. Every value is a text child, so a page can't put markup in the app.
 */
export function SearchData({ run }: { run: RunState }) {
  return (
    <>
      <h1>Search data</h1>
      <p className="subject">{run.url}</p>
      <Content key={run.id} run={run} />
    </>
  );
}

function Content({ run }: { run: RunState }) {
  if (run.state !== "done" || run.loadError || (!run.checked && !run.result))
    return <RunNotice run={run} what="What the page declares" />;
  if (!run.checked)
    return (
      <p className="notice">
        This check did not keep what the page declares. Check the page again to see it.
      </p>
    );
  return <Page run={run} page={run.checked.page} />;
}

/** "Not set" for what the page does not have, "Empty" for what it has with nothing in it. */
function Declared({ value }: { value: string | undefined }) {
  if (value === undefined) return <span className="muted">Not set</span>;
  if (value === "") return <span className="muted">Empty</span>;
  return <span dir="auto">{value}</span>;
}

function Page({ run, page }: { run: RunState; page: PageData }) {
  const thin = run.result?.findings.findIndex((f) => f.checkId === THIN_PAGE_CHECK) ?? -1;
  return (
    <>
      <dl className="declared">
        <dt>Title</dt>
        <dd>
          <Declared value={page.title} />
        </dd>
        <dt>Canonical</dt>
        <dd>
          <Declared value={page.canonical} />
        </dd>
        <dt>Address read</dt>
        <dd dir="auto">{page.url}</dd>
        <dt>Readable words</dt>
        <dd>{page.words}</dd>
      </dl>

      <section aria-labelledby="words-h">
        <h2 id="words-h">The first 200 readable words</h2>
        {page.words === 0 ? (
          <p className="notice">
            This page has no words a visitor can read without JavaScript.{" "}
            {thin >= 0 ? (
              <>
                See{" "}
                <a href={formatHash(run.id, "problems", thin)}>
                  {CHECK_TITLES[THIN_PAGE_CHECK]?.[0] ?? THIN_PAGE_CHECK}
                </a>{" "}
                in Problems.
              </>
            ) : (
              <>
                See <a href={formatHash(run.id, "problems")}>Problems</a> for what that means for
                the page.
              </>
            )}
          </p>
        ) : (
          <p className="preview" dir="auto">
            {page.firstWords}
          </p>
        )}
      </section>

      <section aria-labelledby="blocks-h">
        <h2 id="blocks-h">Structured data</h2>
        {page.blocks.length === 0 ? (
          <p>This page declares no structured data.</p>
        ) : (
          <ul className="blocks">
            {page.blocks.map((b, i) => (
              <Block key={i} index={i + 1} block={b} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Block({ index, block }: { index: number; block: StructuredBlock }) {
  const id = useId();
  return (
    <li aria-labelledby={id} className="block">
      <h3 id={id}>
        {block.ok
          ? `Block ${index}: ${blockTitle(block.value)}`
          : `Block ${index}: Could not be read`}
      </h3>
      {block.ok ? (
        <Tree nodes={toTree(block.value)} depth={0} />
      ) : (
        <>
          <p className="parse-error">{block.error}</p>
          <pre className="raw" dir="auto">
            <code>{block.raw}</code>
          </pre>
        </>
      )}
    </li>
  );
}

function Tree({ nodes, depth }: { nodes: Node[]; depth: number }) {
  return (
    <ul className="tree">
      {nodes.map((n, i) => (
        <TreeNode key={i} node={n} depth={depth} />
      ))}
    </ul>
  );
}

function TreeNode({ node, depth }: { node: Node; depth: number }) {
  const [open, setOpen] = useState(depth < OPEN_LEVELS);
  const panel = useId();
  if (!node.children)
    return (
      <li>
        <span className="node-key">{node.key}</span>{" "}
        <span className="node-value" dir="auto">
          {node.value === "" ? <span className="muted">Empty</span> : node.value}
        </span>
      </li>
    );
  return (
    <li>
      <button
        type="button"
        className="node-toggle"
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="node-key">{node.key}</span>
        {node.value ? (
          <>
            {" "}
            <span className="node-value" dir="auto">
              {node.value}
            </span>
          </>
        ) : null}
      </button>
      {open ? (
        <div id={panel}>
          <Tree nodes={node.children} depth={depth + 1} />
        </div>
      ) : null}
    </li>
  );
}
