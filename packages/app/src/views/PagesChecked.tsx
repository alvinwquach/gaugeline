import { useState } from "react";
import { footerLines, isProblem, toRows, type Row } from "../pages/rows";
import type { RunState } from "../store";
import { RunNotice } from "./RunNotice";

/** What each kind is called in a row. */
const KIND_NAME = {
  page: "Page",
  link: "Link",
  image: "Image",
  sitemap: "Sitemap page",
  feed: "Feed",
  script: "JavaScript file",
  "extra-page": "Other page",
  other: "Other",
} as const;

/**
 * Every address the check requested and what it answered. An address is text in a code element,
 * never a link: it comes from the page being checked, and one stray click must not leave the app.
 */
export function PagesChecked({ run }: { run: RunState }) {
  // A new key is a new view: the filter starts over for each run.
  return (
    <>
      <h1>Pages checked</h1>
      <p className="subject">{run.url}</p>
      <Content key={run.id} run={run} />
    </>
  );
}

function Content({ run }: { run: RunState }) {
  const notice = <RunNotice run={run} what="Every address the check requested" />;
  const requests = run.checked?.requests;
  if (run.state !== "done" || run.loadError) return notice;
  if (!run.checked || !requests)
    return (
      <p className="notice">
        {run.checked || run.result
          ? "This check did not keep a list of its addresses. Check the page again to see them."
          : "Loading the results..."}
      </p>
    );
  if (requests.length === 0) return <p className="notice">No addresses were requested.</p>;
  return <Table rows={toRows(requests)} sampled={run.result?.sampled ?? {}} />;
}

function Table({
  rows,
  sampled,
}: {
  rows: Row[];
  sampled: NonNullable<RunState["result"]>["sampled"];
}) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const problems = rows.filter(isProblem);
  const shown = onlyProblems ? problems : rows;
  const count = `Showing ${shown.length} of ${rows.length} ${rows.length === 1 ? "address" : "addresses"}`;
  const lines = footerLines(sampled);
  return (
    <>
      <p>
        Every address the check requested, and what it answered. Addresses are text, not links: copy
        one to open it yourself.
      </p>
      <div className="filters">
        <div className="filter-group">
          <button
            type="button"
            className="filter"
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems(!onlyProblems)}
          >
            Only problems ({problems.length})
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <>
          <p className="count">{count}</p>
          <p className="notice">Every address loaded.</p>
        </>
      ) : (
        <div className="table-wrap">
          <table className="pages-table">
            <caption>{count}</caption>
            <colgroup>
              <col className="col-address" />
              <col className="col-kind" />
              <col className="col-request" />
              <col className="col-answer" />
              <col className="col-time" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Kind</th>
                <th scope="col">Request</th>
                <th scope="col">Answer</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <RowView key={i} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-footer">
        {lines.length > 0 ? (
          <p>Checked {lines.join(", ")}.</p>
        ) : (
          <p>The page had no links, images, sitemap pages, feeds or JavaScript files to sample.</p>
        )}
        <p className="muted">
          Other addresses are the files every site has (robots.txt, the sitemap files) and anything
          else a check asked for. They are listed in full.
        </p>
      </div>
    </>
  );
}

function RowView({ row }: { row: Row }) {
  const problem = isProblem(row);
  return (
    <tr className={problem ? "row-problem" : undefined}>
      <th scope="row">
        <code dir="auto">{row.address}</code>
      </th>
      <td>{KIND_NAME[row.kind]}</td>
      <td>{row.method}</td>
      <td className="answer">
        {row.redirectedTo === undefined ? (
          row.answer
        ) : (
          <>
            Moved to <code dir="auto">{row.redirectedTo}</code>
          </>
        )}
      </td>
      <td>{row.ms} ms</td>
    </tr>
  );
}
