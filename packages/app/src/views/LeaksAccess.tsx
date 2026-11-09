import { useId } from "react";
import {
  toLeaksModel,
  type Availability,
  type DatasetPanel,
  type KeyEntry,
  type LeaksModel,
  type ScriptRow,
  type StagingRow,
} from "../leaks/model";
import { formatHash } from "../route";
import type { RunState } from "../store";
import { RunNotice } from "./RunNotice";

/** What the privacy page says is read from a dataset. */
const DATASET_READ =
  "Only the number of documents and the names of their types. Never their contents.";

/**
 * What the checks already found about keys in JavaScript, a public Sanity dataset and staging
 * copies. It reads the model, never the result, and runs no check. Every value from the checked
 * page (a type name, a file address, a masked key) is a text child: React escapes it, and nothing
 * here sets HTML. An address is text, never a link; the only links go to Problems.
 */
export function LeaksAccess({ run }: { run: RunState }) {
  return (
    <>
      <h1>Leaks &amp; access</h1>
      <p className="subject">{run.url}</p>
      <Content key={run.id} run={run} />
    </>
  );
}

function Content({ run }: { run: RunState }) {
  const notice = <RunNotice run={run} what="What the checks found about keys and access" />;
  if (run.state !== "done" || run.loadError || !run.result) return notice;
  const model = toLeaksModel(run.result, run.checked);
  return (
    <>
      <DatasetSection id={run.id} model={model} />
      <TypesSection model={model} />
      <ScriptsSection id={run.id} model={model} />
      <StagingSection id={run.id} model={model} />
    </>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="leaks-panel">
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** The reason a check did not run, in place of anything that could look like an all clear. */
function NotRun({ availability }: { availability: Extract<Availability, { ran: false }> }) {
  return <p className="notice">Not checked: {availability.reason}</p>;
}

function FindingLinks({ id, indexes, label }: { id: string; indexes: number[]; label?: string }) {
  if (indexes.length === 0) return null;
  return (
    <>
      {indexes.map((n) => (
        <a key={n} className="finding-link" href={formatHash(id, "problems", n)}>
          {label ?? "See the finding"}
        </a>
      ))}
    </>
  );
}

const VISIBILITY = {
  public: "Public: it answers questions without a token.",
  private: "Private: it asked for a token.",
  unknown: "Could not be read: the dataset gave no clear answer.",
} as const;

function DatasetSection({ id, model }: { id: string; model: LeaksModel }) {
  const { availability, datasets } = model.dataset;
  return (
    <Panel title="Sanity dataset">
      <p className="muted">What was read: {DATASET_READ}</p>
      {!availability.ran ? (
        <NotRun availability={availability} />
      ) : !model.kept ? (
        <p className="notice">This check did not keep what it read about the dataset.</p>
      ) : datasets.length === 0 ? (
        <p>This page does not use Sanity.</p>
      ) : (
        datasets.map((d) => (
          <dl key={`${d.projectId}/${d.dataset}`} className="facts">
            <dt>Project</dt>
            <dd>
              <code dir="auto">{d.projectId}</code>
            </dd>
            <dt>Dataset</dt>
            <dd>
              <code dir="auto">{d.dataset}</code>
            </dd>
            <dt>Visibility</dt>
            <dd className={d.visibility === "public" ? "is-open" : undefined}>
              {VISIBILITY[d.visibility]} <FindingLinks id={id} indexes={d.findings} />
            </dd>
          </dl>
        ))
      )}
    </Panel>
  );
}

function TypesSection({ model }: { model: LeaksModel }) {
  const open = model.dataset.availability.ran
    ? model.dataset.datasets.filter((d) => d.visibility === "public")
    : [];
  if (open.length === 0) return null;
  return (
    <Panel title="Types it holds">
      <p className="muted">What was read: {DATASET_READ}</p>
      {open.map((d) => (
        <TypeList key={`${d.projectId}/${d.dataset}`} d={d} several={open.length > 1} />
      ))}
    </Panel>
  );
}

function TypeList({ d, several }: { d: DatasetPanel; several: boolean }) {
  const n = d.documentCount ?? 0;
  const t = d.types.length;
  return (
    <>
      {several ? (
        <h3>
          <code dir="auto">
            {d.projectId}/{d.dataset}
          </code>
        </h3>
      ) : null}
      <p>{`${n} ${n === 1 ? "document" : "documents"} in ${t} ${t === 1 ? "type" : "types"}`}</p>
      {t === 0 ? null : (
        <ul className="type-list" tabIndex={0} aria-label={`Type names (${t})`}>
          {d.types.map((name, i) => (
            <li key={i}>
              <code dir="auto">{name}</code>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ScriptsSection({ id, model }: { id: string; model: LeaksModel }) {
  const { availability, rows, scanned, limit, notScanned } = model.scripts;
  return (
    <Panel title="JavaScript scanned for keys">
      <p className="muted">
        What was read: the page&apos;s inline scripts and up to {limit} of the site&apos;s own
        JavaScript files. A key is shown masked, as the check emits it: the first 6 and the last 2
        characters. The full value never reaches this app.
      </p>
      {!availability.ran ? (
        <NotRun availability={availability} />
      ) : (
        <>
          {!model.kept ? (
            <p className="notice">
              This check did not keep the list of files it scanned. Only files with a key found are
              listed.
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p>
              {model.kept
                ? "The page has no JavaScript file of its own, and no key was found in its inline scripts."
                : "No key was found."}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="pages-table leaks-table">
                <caption>{`${rows.length} ${rows.length === 1 ? "file" : "files"} listed`}</caption>
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <ScriptRowView key={i} id={id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {model.kept ? (
            <div className="table-footer">
              <p>{`${scanned} of up to ${limit} JavaScript files scanned`}</p>
              {notScanned > 0 ? (
                <p className="muted">
                  {`${notScanned} more JavaScript ${notScanned === 1 ? "file" : "files"} on the page ${notScanned === 1 ? "was" : "were"} not scanned.`}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function ScriptRowView({ id, row }: { id: string; row: ScriptRow }) {
  return (
    <tr className={row.keys.length > 0 ? "row-problem" : undefined}>
      <th scope="row">
        <code dir="auto">{row.address}</code>
      </th>
      <td>
        {row.keys.length > 0 ? (
          <ul className="keys">
            {row.keys.map((k, i) => (
              <KeyView key={i} id={id} k={k} />
            ))}
          </ul>
        ) : row.state === "scanned" ? (
          "Nothing found"
        ) : row.state === "partial" ? (
          `Nothing found in the part read. ${row.note ?? ""}`
        ) : (
          `Not scanned. ${row.note ?? ""}`
        )}
      </td>
    </tr>
  );
}

function KeyView({ id, k }: { id: string; k: KeyEntry }) {
  return (
    <li>
      {k.kind} <code dir="auto">{k.masked}</code> <FindingLinks id={id} indexes={[k.finding]} />
    </li>
  );
}

const REACH: Record<StagingRow["kind"], string> = {
  "preview-link": "Preview link",
  "staging-host": "Staging address",
  "this-page": "This page",
};

function StagingSection({ id, model }: { id: string; model: LeaksModel }) {
  const { availability, rows, notes } = model.staging;
  return (
    <Panel title="Staging copies">
      <p className="muted">
        What was read: the links on the page, and one request to the staging address of your domain
        (staging. in front of its name). Preview links are not requested.
      </p>
      {!availability.ran ? (
        <NotRun availability={availability} />
      ) : (
        <>
          {rows.length === 0 ? (
            <p>No preview links were found, and no staging address answers publicly.</p>
          ) : (
            <div className="table-wrap">
              <table className="pages-table leaks-table">
                <caption>{`${rows.length} ${rows.length === 1 ? "address" : "addresses"} found`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Address</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Answers publicly</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className={r.reachable === "yes" ? "row-problem" : undefined}>
                      <th scope="row">
                        <code dir="auto">{r.address}</code>
                      </th>
                      <td>{REACH[r.kind]}</td>
                      <td>
                        {r.reachable === "yes" ? "Yes. " : r.reachable === "no" ? "No. " : ""}
                        {r.answer}{" "}
                        <FindingLinks
                          id={id}
                          indexes={r.finding === undefined ? [] : [r.finding]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {notes.map((n, i) => (
            <p key={i} className="muted">
              Not checked: {n}
            </p>
          ))}
        </>
      )}
    </Panel>
  );
}
