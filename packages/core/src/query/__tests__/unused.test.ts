import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../errors.js";
import type { SourceRef } from "../shape.js";
import { analyseUnused, findUnusedFields, type UnusedAnalysis } from "../unused.js";

/** A repository written into a temporary folder, read with the real compiler, then removed. */
const made: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-unused-")));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.restoreAllMocks();
});

const paths = (a: UnusedAnalysis): string[] =>
  a.findings.map((f) => f.evidence.split(" \u00B7 ")[0] ?? "");
const where = (s: SourceRef): string => `${s.file}:${s.line}`;

/** The query, a page that reads it, and nothing else: the smallest repository. */
const QUERY = [
  'import { groq } from "next-sanity";',
  "export const POSTS = groq`", // line 2
  '  *[_type == "post"]{ _id, title, "slug": slug.current, summary, author->{ name, bio } }',
  "`;",
].join("\n");

describe("a field the code reads is used", () => {
  it("through destructuring, through props two components deep, and inside a map callback", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        'import { List } from "./List";',
        "export default async function Page() {",
        "  const { title } = (await client.fetch(POSTS))[0];",
        "  const posts = await client.fetch(POSTS);",
        "  return <main><h1>{title}</h1><List posts={posts} /></main>;",
        "}",
      ].join("\n"),
      "List.tsx": [
        'import { Row } from "./Row";',
        "export function List({ posts }) {",
        "  return <ul>{posts.map((p) => <Row key={p._id} item={p} />)}</ul>;",
        "}",
      ].join("\n"),
      "Row.tsx": [
        "export function Row(props) {",
        "  const { slug } = props.item;",
        "  return <li>{props.item.summary}<a href={slug}>{props.item.author.name} {props.item.author.bio}</a></li>;",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.findings).toEqual([]);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.queries).toBe(1);
  });

  it("a field read with an optional chain, an element access by a literal, and a for..of loop", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export async function run() {",
        "  const posts = await client.fetch(POSTS);",
        "  const out = [];",
        "  for (const post of posts) out.push(post?.title, post['summary']);",
        "  for (const { slug, author: { name } } of posts) out.push(slug, name);",
        "  return out.length;",
        "}",
        "export function main() { return run(); }",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    // author.bio is the only field nobody reads.
    expect(paths(out)).toEqual(["author.bio"]);
  });

  it("a value that is assigned later, filtered, sliced and found", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export async function run(slug) {",
        "  let posts;",
        "  posts = await client.fetch(POSTS);",
        "  const top = posts.filter((p) => p.title).slice(0, 3);",
        "  const one = posts.find((p) => p.slug === slug);",
        "  return [top[0].summary, one?.author?.name, one?.author?.bio];",
        "}",
        "export const x = run('a');",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it("when it is read only inside generateMetadata", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        "export const POST = groq`",
        '  *[_type == "post" && slug.current == $slug][0]{ title, seoTitle, body }',
        "`;",
      ].join("\n"),
      "page.tsx": [
        'import { client } from "./client";',
        'import { POST } from "./queries";',
        "const getPost = (slug) => client.fetch(POST, { slug });",
        "export async function generateMetadata({ params }) {",
        "  const post = await getPost(params.slug);",
        "  return { title: post.seoTitle };",
        "}",
        "export default async function Page({ params }) {",
        "  const post = await getPost(params.slug);",
        "  return <article><h1>{post.title}</h1>{post.body}</article>;",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it("through a function that returns the result and a caller in another file", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "data.ts": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export async function getPosts() { return client.fetch(POSTS); }",
      ].join("\n"),
      "page.tsx": [
        'import { getPosts } from "./data";',
        "export default async function Page() {",
        "  const posts = await getPosts();",
        "  return posts.map((p) => p.title);",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(paths(out)).toEqual(["slug", "summary", "author"]);
  });

  it("through sanityFetch and useQuery, which hand the result back in a data property", async () => {
    const dir = repo({
      "queries.ts": [
        'import { defineQuery } from "next-sanity";',
        'export const A = defineQuery(`*[_type == "settings"][0]{ phone, address }`);',
        'export const B = defineQuery(`*[_type == "settings"][0]{ email, fax }`);',
      ].join("\n"),
      "page.tsx": [
        'import { sanityFetch } from "./live";',
        'import { useQuery } from "./hooks";',
        'import { A, B } from "./queries";',
        "export async function Footer() {",
        "  const { data } = await sanityFetch({ query: A });",
        "  return <p>{data.phone}</p>;",
        "}",
        "export function Contact() {",
        "  const { data: settings } = useQuery(B);",
        "  return <p>{settings?.email}</p>;",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(paths(out)).toEqual(["address", "fax"]);
  });

  it("a result awaited together with another through Promise.all", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        'export const A = groq`*[_type == "a"]{ one, two }`;',
        'export const B = groq`*[_type == "b"]{ three, four }`;',
      ].join("\n"),
      "page.tsx": [
        'import { client } from "./client";',
        'import { A, B } from "./queries";',
        "export async function run() {",
        "  const [as, bs] = await Promise.all([client.fetch(A), client.fetch(B)]);",
        "  return [as.map((a) => a.one), bs.map((b) => b.three)];",
        "}",
        "export const r = run();",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(paths(out)).toEqual(["two", "four"]);
  });

  it("through an import written with a path alias from tsconfig.json", async () => {
    const dir = repo({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "src/lib/queries.ts": QUERY,
      "src/components/Card.tsx":
        "export function Card({ post }) { return <b>{post.title}{post.slug}{post.summary}{post.author.name}{post.author.bio}</b>; }",
      "src/app/page.tsx": [
        'import { client } from "@/lib/client";',
        'import { POSTS } from "@/lib/queries";',
        'import { Card } from "@/components/Card";',
        "export default async function Page() {",
        "  const posts = await client.fetch(POSTS);",
        "  return posts.map((p) => <Card key={p._id} post={p} />);",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.findings).toEqual([]);
  });
});

describe("flows through the shapes real pages use", () => {
  const Q = [
    'import { groq } from "next-sanity";',
    'export const Q = groq`*[_type == "post"][0]{ title, summary, cover }`;',
  ].join("\n");
  const FETCH = [
    'import { client } from "./client";',
    'import { Q } from "./queries";',
    "export const load = () => client.fetch(Q);",
  ].join("\n");

  it("a default-exported component, memo, a function passed by name and a props object", async () => {
    const dir = repo({
      "queries.ts": Q,
      "load.ts": FETCH,
      "Card.tsx": [
        'import { memo } from "react";',
        "function Card({ post }) { return <b>{post.title}</b>; }",
        "export default memo(Card);",
      ].join("\n"),
      "Summary.tsx": "export default function Summary(props) { return <i>{props.text}</i>; }",
      "page.tsx": [
        'import Card from "./Card";',
        'import Summary from "./Summary";',
        'import { load } from "./load";',
        "const show = (post) => <Cover src={post.cover} />;",
        "export default async function Page() {",
        "  const post = await load();",
        "  const props = { post, text: post.summary };",
        "  return <><Card {...props} />{show(post)}<Summary text={post.summary} /></>;",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it("a result returned inside an object and taken apart by the caller", async () => {
    const dir = repo({
      "queries.ts": Q,
      "load.ts": [
        'import { client } from "./client";',
        'import { Q } from "./queries";',
        "export async function loadPage() {",
        "  const post = await client.fetch(Q);",
        "  return { post, fetchedAt: 1 };",
        "}",
      ].join("\n"),
      "page.tsx": [
        'import * as data from "./load";',
        "export default async function Page() {",
        "  const { post } = await data.loadPage();",
        "  return <h1>{post.title}{post.summary}</h1>;",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(paths(out)).toEqual(["cover"]);
  });

  it("a field read through a type guard, a default value and a ternary", async () => {
    const dir = repo({
      "queries.ts": Q,
      "page.tsx": [
        'import { client } from "./client";',
        'import { Q } from "./queries";',
        "export async function run() {",
        "  const post = (await client.fetch(Q)) as { title: string } | null;",
        "  if (!post) return null;",
        "  const title = post.title ?? 'Untitled';",
        "  const summary = post.summary ? post.summary : '';",
        "  return [title, summary, post!.cover];",
        "}",
        "export const r = run();",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it("a callback written as a function declaration, and Promise.then", async () => {
    const dir = repo({
      "queries.ts": Q,
      "page.tsx": [
        'import { client } from "./client";',
        'import { Q } from "./queries";',
        "function pick(post) { return post.title; }",
        "export const r = client.fetch(Q).then(pick);",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(paths(out)).toEqual(["summary", "cover"]);
  });
});

describe("a field the code never reads is reported", () => {
  it("with the file and the line the query starts on, and the field path", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export async function run() {",
        "  const posts = await client.fetch(POSTS);",
        "  return posts.map((p) => [p.title, p.slug, p.author.name]);",
        "}",
        "export const r = run();",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.findings.map((f) => [f.checkId, f.severity, f.title, f.source])).toEqual([
      [
        "query-field-unused",
        "medium",
        "summary is fetched and never used",
        { file: "queries.ts", line: 2 },
      ],
      [
        "query-field-unused",
        "medium",
        "author.bio is fetched and never used",
        { file: "queries.ts", line: 2 },
      ],
    ]);
    expect(out.findings[0]?.evidence).toBe("summary \u00B7 queries.ts:2");
    expect(out.findings[0]?.url).toBe("query:queries.ts:2");
  });

  it("findUnusedFields returns the same findings", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export const r = client.fetch(POSTS).then((posts) => posts.map((p) => p.title));",
      ].join("\n"),
    });
    const findings = await findUnusedFields(dir);
    expect((await analyseUnused(dir)).findings).toEqual(findings);
    expect(findings.map((f) => f.title)).toContain("summary is fetched and never used");
  });

  it("matches an alias by its alias name, not by the path it was read from", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        'export const Q = groq`*[_type == "post"]{ "slug": slug.current, "heading": title }`;',
      ].join("\n"),
      "page.tsx": [
        'import { client } from "./client";',
        'import { Q } from "./queries";',
        "export async function run() {",
        "  const posts = await client.fetch(Q);",
        // slug is read by its alias; title is the source path of heading and not a name in the result.
        "  return posts.map((p) => [p.slug, p.title, p.current]);",
        "}",
        "export const r = run();",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(paths(out)).toEqual(["heading"]);
  });

  it("only on the query that does not read it, when two queries share a field name", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        'export const A = groq`*[_type == "post"]{ title, summary }`;', // line 2
        'export const B = groq`*[_type == "page"]{ title, summary }`;', // line 3
      ].join("\n"),
      "page.tsx": [
        'import { client } from "./client";',
        'import { A, B } from "./queries";',
        "export async function run() {",
        "  const a = await client.fetch(A);",
        "  const b = await client.fetch(B);",
        "  return [a.map((x) => [x.title, x.summary]), b.map((y) => y.title)];",
        "}",
        "export const r = run();",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.findings).toHaveLength(1);
    expect(paths(out)).toEqual(["summary"]);
    expect(where(out.findings[0]?.source as SourceRef)).toBe("queries.ts:3");
  });

  it("never reports _id, _type, _key or _rev", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        'export const Q = groq`*[_type == "post"]{ _id, _type, _key, _rev, title }`;',
      ].join("\n"),
      "page.tsx": [
        'import { client } from "./client";',
        'import { Q } from "./queries";',
        "export const r = client.fetch(Q).then((p) => p.map((x) => x.title));",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.findings).toEqual([]);
  });

  it("a field of a nested object, when the object is read and one of its fields is not", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export const r = client.fetch(POSTS).then((ps) => ps.map((p) => [p.title, p.slug, p.summary, p.author.name]));",
      ].join("\n"),
    });
    expect(paths(await analyseUnused(dir))).toEqual(["author.bio"]);
  });

  it("an object handed whole to code the walker cannot open counts as read, and nothing inside is reported", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        'export const Q = groq`*[_type == "post"]{ title, image{ asset, alt, crop } }`;',
      ].join("\n"),
      "page.tsx": [
        'import Image from "next/image";',
        'import { client } from "./client";',
        'import { Q } from "./queries";',
        "export async function run() {",
        "  const posts = await client.fetch(Q);",
        "  return posts.map((p) => <section>{p.title}<Image {...p.image} /></section>);",
        "}",
        "export const r = run();",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    expect(out.findings).toEqual([]);
  });

  it("GraphQL: a field selected in a fragment and read in the component that owns the fragment", async () => {
    const dir = repo({
      "PostCard.tsx": [
        'import { gql } from "graphql-tag";',
        "export const POST_CARD = gql`", // line 2
        "  fragment PostCard on Post { title headline: summary cover }",
        "`;",
        "export function PostCard({ post }) {",
        "  return <a>{post.title}{post.headline}</a>;",
        "}",
      ].join("\n"),
      "page.tsx": [
        'import { gql } from "graphql-tag";',
        'import { useQuery } from "@apollo/client";',
        'import { PostCard } from "./PostCard";',
        "const POSTS = gql`", // line 4
        "  query Posts { allPost { _id ...PostCard } }",
        "`;",
        "export function Page() {",
        "  const { data } = useQuery(POSTS);",
        "  return data.allPost.map((p) => <PostCard key={p._id} post={p} />);",
        "}",
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.couldNotFollow).toEqual([]);
    // title and the alias headline are read by the component; cover is not.
    expect(paths(out)).toEqual(["allPost.cover"]);
    // The finding is on the operation (the line `query Posts` is on), and says which fragment holds the field.
    expect(where(out.findings[0]?.source as SourceRef)).toBe("page.tsx:5");
    expect(out.findings[0]?.evidence).toBe(
      "allPost.cover \u00B7 page.tsx:5 \u00B7 in fragment PostCard (PostCard.tsx:3)",
    );
  });

  it("GraphQL: an alias is matched by its alias, and a __typename is never reported", async () => {
    const dir = repo({
      "page.tsx": [
        'import { gql } from "graphql-tag";',
        'import { useQuery } from "@apollo/client";',
        "const Q = gql`query { allPost { __typename name: title title } }`;",
        "export function Page() {",
        "  const { data } = useQuery(Q);",
        "  return data.allPost.map((p) => p.name);",
        "}",
      ].join("\n"),
    });
    expect(paths(await analyseUnused(dir))).toEqual(["allPost.title"]);
  });
});

describe("a result that escapes analysis is could not follow, with no field findings", () => {
  const ESCAPES: Array<[string, string]> = [
    ["passed whole to JSON.stringify", "export const r = JSON.stringify(await client.fetch(Q));"],
    [
      "indexed with a value that is not known (item[key])",
      "export const r = (await client.fetch(Q)).map((item) => item[process.argv[2]]);",
    ],
    [
      "spread whole into a component it cannot open",
      "export const r = <Unknown {...(await client.fetch(Q))[0]} />;",
    ],
    [
      "handed to a function that is not in the repository",
      "export const r = structuredClone(await client.fetch(Q));",
    ],
    ["stored with useState", "export const r = useState(await client.fetch(Q));"],
    [
      "returned from an exported function nothing calls",
      "export async function getAll() { return client.fetch(Q); }",
    ],
  ];
  for (const [name, body] of ESCAPES) {
    it(name, async () => {
      const dir = repo({
        "queries.ts": [
          'import { groq } from "next-sanity";',
          'export const Q = groq`*[_type == "post"]{ title, summary }`;',
        ].join("\n"),
        "page.tsx": [
          'import { client } from "./client";',
          'import { Q } from "./queries";',
          body,
        ].join("\n"),
      });
      const out = await analyseUnused(dir);
      expect(out.findings, name).toEqual([]);
      expect(out.couldNotFollow, name).toHaveLength(1);
      expect(out.couldNotFollow[0]?.source).toEqual({ file: "queries.ts", line: 2 });
      expect(out.couldNotFollow[0]?.reason.length).toBeGreaterThan(10);
    });
  }

  it("a query that is built at run time, one that is not GROQ, and one nothing fetches", async () => {
    const dir = repo({
      "queries.ts": [
        'import { groq } from "next-sanity";',
        "const type = 'post';",
        "export const A = groq`*[_type == '${type}']{ title }`;", // line 3
        "export const B = groq`*[[[`;", // line 4
        'export const C = groq`*[_type == "post"]{ title }`;', // line 5
      ].join("\n"),
    });
    const out = await analyseUnused(dir);
    expect(out.findings).toEqual([]);
    expect(out.couldNotFollow.map((c) => where(c.source))).toEqual([
      "queries.ts:3",
      "queries.ts:4",
      "queries.ts:5",
    ]);
  });

  it("every query, when a file does not parse, because the unread file may be the one that reads it", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export const r = client.fetch(POSTS).then((p) => p.map((x) => x.title));",
      ].join("\n"),
      "broken.tsx": "export function Broken() { return <div>; }",
    });
    const out = await analyseUnused(dir);
    expect(out.findings).toEqual([]);
    expect(out.couldNotFollow).toHaveLength(1);
    expect(out.couldNotFollow[0]?.reason).toContain("broken.tsx");
  });

  it("a GraphQL document in a .graphql file, which the code reaches through a loader", async () => {
    const dir = repo({
      "q.graphql": "query Q { allPost { title } }",
      "page.ts": "export const x = 1;",
    });
    const out = await analyseUnused(dir);
    expect(out.findings).toEqual([]);
    expect(out.couldNotFollow.map((c) => where(c.source))).toEqual(["q.graphql:1"]);
  });
});

describe("the invented clinic repository (packages/fixtures/repo-unused)", () => {
  const clinic = fileURLToPath(new URL("../../../../fixtures/repo-unused/", import.meta.url));

  it("has six queries, four planted unused fields and one result that escapes: exactly four findings and one could-not-follow", async () => {
    const out = await analyseUnused(clinic);
    expect(out.queries).toBe(6);
    expect(out.fields.map((f) => [f.path, f.alias, where(f.source)])).toEqual([
      ["summary", "summary", "src/lib/queries.ts:3"],
      ["practitioner.bio", "bio", "src/lib/queries.ts:13"],
      ["instagram", "instagram", "src/lib/queries.ts:23"],
      ["qualifications", "qualifications", "src/lib/queries.ts:32"],
    ]);
    expect(out.findings).toHaveLength(4);
    expect(out.couldNotFollow).toHaveLength(1);
    expect(out.couldNotFollow[0]).toMatchObject({
      language: "groq",
      source: { file: "src/lib/queries.ts", line: 45 },
    });
    expect(out.couldNotFollow[0]?.reason).toContain("JSON.stringify");
  });

  it("reads the same when given the src folder, and puts the folder as typed in front of every file", async () => {
    const out = await analyseUnused(join(clinic, "src"), { prefix: "./src/" });
    expect(out.findings.map((f) => f.source?.file)).toEqual([
      "./src/lib/queries.ts",
      "./src/lib/queries.ts",
      "./src/lib/queries.ts",
      "./src/lib/queries.ts",
    ]);
    expect(out.couldNotFollow[0]?.reason).toContain("./src/app/api/search-index/route.ts:6");
  });
});

describe("the invented clinic repository (packages/fixtures/repo-unused)", () => {
  const clinic = fileURLToPath(new URL("../../../../fixtures/repo-unused/", import.meta.url));

  it("has six queries, four planted unused fields and one result that escapes: exactly four findings and one could-not-follow", async () => {
    const out = await analyseUnused(clinic);
    expect(out.queries).toBe(6);
    expect(out.fields.map((f) => [f.path, f.alias, where(f.source)])).toEqual([
      ["summary", "summary", "src/lib/queries.ts:3"],
      ["practitioner.bio", "bio", "src/lib/queries.ts:13"],
      ["instagram", "instagram", "src/lib/queries.ts:23"],
      ["qualifications", "qualifications", "src/lib/queries.ts:32"],
    ]);
    expect(out.findings).toHaveLength(4);
    expect(out.couldNotFollow).toHaveLength(1);
    expect(out.couldNotFollow[0]).toMatchObject({
      language: "groq",
      source: { file: "src/lib/queries.ts", line: 45 },
    });
    expect(out.couldNotFollow[0]?.reason).toContain("JSON.stringify");
  });

  it("reads the same when given the src folder, and puts the folder as typed in front of every file", async () => {
    const out = await analyseUnused(join(clinic, "src"), { prefix: "./src/" });
    expect(out.findings.map((f) => f.source?.file)).toEqual([
      "./src/lib/queries.ts",
      "./src/lib/queries.ts",
      "./src/lib/queries.ts",
      "./src/lib/queries.ts",
    ]);
    expect(out.couldNotFollow[0]?.reason).toContain("./src/app/api/search-index/route.ts:6");
  });
});

describe("what it reads and what it never does", () => {
  it("is the same on every run", async () => {
    const dir = repo({
      "queries.ts": QUERY,
      "page.tsx": [
        'import { client } from "./client";',
        'import { POSTS } from "./queries";',
        "export const r = client.fetch(POSTS).then((p) => p.map((x) => x.title));",
      ].join("\n"),
    });
    const a = await analyseUnused(dir);
    const b = await analyseUnused(dir);
    expect(b).toEqual(a);
    expect(a.findings.length).toBeGreaterThan(0);
  });

  it("says how to bring TypeScript when it is not installed", async () => {
    const dir = repo({ "a.ts": "export {};" });
    await expect(
      analyseUnused(dir, { loadTypeScript: () => Promise.reject(new Error("not found")) }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("is a ConfigError for a folder that does not exist", async () => {
    await expect(
      analyseUnused(join(tmpdir(), "gaugeline-no-such-folder-xyz")),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("does not read the environment, and sends nothing, with fetch and the network stubbed to throw", async () => {
    const boom = (): never => {
      throw new Error("the unused-field analysis reached for the network");
    };
    vi.stubGlobal("fetch", boom);
    vi.stubEnv("SANITY_TOKEN", "");
    vi.stubEnv("SANITY_PROJECT_ID", "");
    try {
      const dir = repo({
        "queries.ts": QUERY,
        "page.tsx": [
          'import { client } from "./client";',
          'import { POSTS } from "./queries";',
          "export const r = client.fetch(POSTS).then((p) => p.map((x) => x.title));",
        ].join("\n"),
      });
      const out = await analyseUnused(dir);
      expect(out.findings.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("the modules do not import the fetcher, a connector, an HTTP client or the environment", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["unused.ts", "unused-flow.ts", "unused-trees.ts"]) {
      const source = readFileSync(join(here, "..", name), "utf8");
      // Comments name client.fetch(...) to explain what is followed; only code counts.
      const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1] ?? "",
      );
      for (const spec of imports)
        expect(spec, `${name} imports ${spec}`).not.toMatch(
          /fetcher|connectors|node:http|node:https|node:net|node:dns|undici|sanity/,
        );
      expect(text, `${name} reads process.env`).not.toMatch(/process\.env/);
      expect(text, `${name} calls fetch`).not.toMatch(/\bfetch\(/);
    }
  });
});
