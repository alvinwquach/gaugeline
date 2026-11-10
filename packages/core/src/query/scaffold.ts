import { TYPE_NAME } from "../connectors/sanity.js";
import type { ContentShape, FieldShape } from "./content-shape.js";
import { projection, type ProjectionEntry } from "./suggest.js";

/** One file of the scaffold, as text. The CLI decides where it goes; nothing here touches a disk. */
export interface GeneratedFile {
  name: "queries.ts" | "types.ts" | "page.tsx";
  text: string;
}

/** Sanity's own rule for a field name; the scaffold places a name in code only when it matches. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the generated files already use, so an interface is never called one of them. */
const TAKEN = new Set([
  ...["Props", "Image", "Link", "Metadata", "PortableText", "PortableTextBlock"],
  ...["Array", "Boolean", "Date", "Error", "Map", "Number", "Object", "Promise", "Record"],
  ...["Set", "String", "Symbol", "URL", "Function", "Partial", "Pick", "Omit", "Readonly"],
]);

/** The title and description are the first of these names the type has, as a string. */
const TITLES = ["title", "name", "heading"];
const DESCRIPTIONS = ["description", "summary", "excerpt"];

const indent = (text: string, by = 1): string =>
  text
    .split("\n")
    .map((l) => (l === "" ? l : `${"  ".repeat(by)}${l}`))
    .join("\n");

/** `blog-post` and `blog_post` both give `BlogPost`; a name that is taken gets `Document` after it. */
function interfaceName(type: string): string {
  const words = type.split(/[^A-Za-z0-9]+/).filter((w) => w !== "");
  const pascal = words.map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`).join("");
  return TAKEN.has(pascal) ? `${pascal}Document` : pascal;
}

const camel = (name: string): string => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/** The fields that are on at least one document: the only ones the query asks for. */
const live = (fields: readonly FieldShape[]): FieldShape[] => fields.filter((f) => f.present > 0);

/** Every field name, at every level, is placed in code: each must be a plain identifier. */
function checkNames(fields: readonly FieldShape[]): void {
  for (const f of fields) {
    if (!IDENTIFIER.test(f.name))
      throw new Error(`The field ${JSON.stringify(f.name)} cannot be written as an identifier.`);
    checkNames(f.of ?? []);
  }
}

// ---------------------------------------------------------------------------------------------
// types.ts
// ---------------------------------------------------------------------------------------------

const REFERENCE = "{ _id: string; title: string | null; slug: string | null }";

/** `{ a: string; b?: number }` on one line when it is short, one member for each line when it is not. */
function literal(members: readonly string[], depth: number): string {
  const flat = `{ ${members.join("; ")} }`;
  if (flat.length <= 72 && !members.some((m) => m.includes("\n"))) return flat;
  const pad = "  ".repeat(depth + 1);
  return `{\n${members.map((m) => `${pad}${m};`).join("\n")}\n${"  ".repeat(depth)}}`;
}

/** What the query writes for an image or a file itself: a field of the same name inside it is not written twice. */
const OWN = {
  image: new Set(["url", "alt", "width", "height"]),
  file: new Set(["url", "name", "size", "alt"]),
};

const members = (
  fields: readonly FieldShape[],
  of: number,
  depth: number,
  own: ReadonlySet<string> = new Set(),
): string[] =>
  live(fields)
    .filter((f) => !own.has(f.name))
    .map((f) => member(f, of, depth));

/** What a field's value is, as the query writes it. */
function valueType(f: FieldShape, depth: number): string {
  if (f.mixed) return "unknown";
  const kind = f.kind === "array" ? f.item : f.kind;
  const own = kind === "image" ? OWN.image : kind === "file" ? OWN.file : new Set<string>();
  const inner = (extra: readonly string[]): string[] => [
    ...extra,
    ...members(f.of ?? [], f.instances ?? f.present, depth + 1, own),
  ];
  switch (f.kind) {
    case "string":
    case "number":
    case "boolean":
      return f.kind;
    case "slug":
      return "string";
    case "portable-text":
      return "PortableTextBlock[]";
    case "reference":
      return `${REFERENCE} | null`;
    case "image":
      return `${literal(inner(["url: string | null", "alt: string", "width: number | null", "height: number | null"]), depth)} | null`;
    case "file":
      return `${literal(inner(["url: string | null", "name: string | null", "size: number | null"]), depth)} | null`;
    case "object":
      return f.of && live(f.of).length > 0
        ? `${literal(inner([]), depth)} | null`
        : "Record<string, unknown> | null";
    case "array": {
      if (f.itemsMixed || f.item === undefined) return "unknown[]";
      switch (f.item) {
        case "string":
        case "number":
        case "boolean":
          return `${f.item}[]`;
        case "reference":
          return `Array<${REFERENCE} | null>`;
        case "image":
          return `Array<${literal(inner(["url: string | null", "alt: string", "width: number | null", "height: number | null"]), depth)}>`;
        case "file":
          return `Array<${literal(inner(["url: string | null", "name: string | null", "size: number | null"]), depth)}>`;
        case "object":
          return f.of && live(f.of).length > 0
            ? `Array<${literal(inner([]), depth)}>`
            : "Array<Record<string, unknown>>";
        default:
          return "unknown[]";
      }
    }
  }
}

/** `name?: type`, optional when the field is on fewer of the documents than its parent was counted over. */
function member(f: FieldShape, of: number, depth: number): string {
  const optional = f.present < of;
  return `${f.name}${optional ? "?" : ""}: ${valueType(f, depth)}`;
}

function typesFile(shape: ContentShape, name: string, listed: readonly string[]): string {
  const fields = live(shape.fields);
  const lines: string[] = [];
  if (fields.some((f) => f.kind === "portable-text" && !f.mixed))
    lines.push('import type { PortableTextBlock } from "@portabletext/react";', "");
  lines.push(
    `// Written by gaugeline query --page from ${documents(shape)}.`,
    "// A field with a ? is missing on some of them, so the compiler makes you guard it.",
    `export interface ${name} {`,
    "  _id: string;",
  );
  for (const f of fields) {
    const line = `  ${member(f, shape.sampled, 1)};`;
    const note =
      f.present < shape.sampled ? ` // on ${f.present} of the ${shape.sampled} documents` : "";
    lines.push(`${line}${note}`);
  }
  lines.push("}");
  if (listed.length > 0)
    lines.push(
      "",
      `export type ${name}ListItem = Pick<${name}, ${["_id", ...listed].map((n) => JSON.stringify(n)).join(" | ")}>;`,
    );
  return `${lines.join("\n")}\n`;
}

const documents = (shape: ContentShape): string =>
  `${shape.sampled} published ${shape.type} ${shape.sampled === 1 ? "document" : "documents"}`;

// ---------------------------------------------------------------------------------------------
// queries.ts
// ---------------------------------------------------------------------------------------------

const DRAFTS = '!(_id in path("drafts.**"))';

/** The fields of a type the route is built from: which one makes the address, the title, the description, the image. */
interface Plan {
  /** The slug field the address is made from, or undefined when there is none and `_id` is used. */
  route: FieldShape | undefined;
  title: FieldShape | undefined;
  description: FieldShape | undefined;
  image: FieldShape | undefined;
}

function plan(fields: readonly FieldShape[]): Plan {
  const strings = (names: readonly string[]): FieldShape | undefined => {
    for (const n of names) {
      const f = fields.find((x) => x.name === n && x.kind === "string" && !x.mixed);
      if (f) return f;
    }
    return undefined;
  };
  return {
    route:
      fields.find((f) => f.name === "slug" && f.kind === "slug" && !f.mixed) ??
      fields.find((f) => f.kind === "slug" && !f.mixed),
    title: strings(TITLES),
    description: strings(DESCRIPTIONS),
    image: fields.find((f) => f.kind === "image" && !f.mixed),
  };
}

/** The one-line comment header of a file. */
const header = (shape: ContentShape): string =>
  `// Written by gaugeline query --page from ${documents(shape)}.`;

function queriesFile(
  shape: ContentShape,
  p: Plan,
  entries: readonly ProjectionEntry[],
  comments: readonly string[],
  names: { list: string; slugs: string; detail: string },
): string {
  const type = JSON.stringify(shape.type);
  const key = p.route === undefined ? "_id" : `${p.route.name}.current`;
  const byName = new Map(entries.map((e) => [e.name, e.text]));
  const listed = listedFields(p).flatMap((f) => {
    const text = byName.get(f.name);
    return text === undefined ? [] : [text];
  });
  const project = (list: readonly string[]): string =>
    ["_id", ...list].map((e) => indent(e)).join(",\n");
  const where = `_type == ${type} && ${DRAFTS}`;
  return [
    'import groq from "groq";',
    "",
    header(shape),
    ...(p.route === undefined
      ? [`// ${shape.type} has no slug field, so the address is made from the document id.`]
      : []),
    ...comments,
    "",
    "// Every published document, newest first, with what a list shows.",
    `export const ${names.list} = groq\`*[${where}] | order(_updatedAt desc) {`,
    `${project(listed)}`,
    "}`;",
    "",
    "// The address of every published document, for generateStaticParams.",
    `export const ${names.slugs} = groq\`*[${where}${p.route === undefined ? "" : ` && defined(${key})`}].${key}\`;`,
    "",
    "// One document by its address, with every field.",
    `export const ${names.detail} = groq\`*[${where} && ${key} == $slug][0] {`,
    `${project(entries.map((e) => e.text))}`,
    "}`;",
    "",
  ].join("\n");
}

/** The fields the list query asks for: the address, the title, the description and the first image. */
function listedFields(p: Plan): FieldShape[] {
  const out = [p.title, p.route, p.description, p.image].filter((f): f is FieldShape => !!f);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------
// page.tsx
// ---------------------------------------------------------------------------------------------

/** The JSX that shows one top-level field. */
function show(f: FieldShape, shape: ContentShape): string[] {
  const v = `doc.${f.name}`;
  const optional = f.present < shape.sampled;
  const comment = (what: string): string[] => [
    `{/* ${f.name} ${what}: write how it should look. */}`,
  ];
  if (f.mixed) return comment("can be more than one kind");
  switch (f.kind) {
    case "string":
    case "slug":
      return optional ? [`{${v} ? <p>{${v}}</p> : null}`] : [`<p>{${v}}</p>`];
    case "number":
    case "boolean":
      return optional
        ? [`{${v} !== undefined ? <p>{String(${v})}</p> : null}`]
        : [`<p>{String(${v})}</p>`];
    case "portable-text":
      return [`<PortableText value={${v}} />`];
    case "reference":
      return [
        `{${v}?.slug ? (`,
        "  <p>",
        `    <Link href={\`/${f.name}/\${${v}.slug}\`}>{${v}.title ?? ${v}.slug}</Link>`,
        "  </p>",
        ") : null}",
      ];
    case "image":
      return [
        `{${v}?.url && ${v}.width && ${v}.height ? (`,
        "  <Image",
        `    src={${v}.url}`,
        `    alt={${v}.alt}`,
        `    width={${v}.width}`,
        `    height={${v}.height}`,
        "  />",
        ") : null}",
      ];
    case "file":
      return [
        `{${v}?.url ? (`,
        "  <p>",
        `    <a href={${v}.url}>{${v}.name ?? "Download"}</a>`,
        "  </p>",
        ") : null}",
      ];
    case "array": {
      const list = optional ? `(${v} ?? [])` : v;
      if (f.itemsMixed || f.item === undefined) return comment("is a list of mixed items");
      if (f.item === "string" || f.item === "number")
        return [
          "<ul>",
          `  {${list}.map((item, i) => (`,
          "    <li key={`${i}-${item}`}>{item}</li>",
          "  ))}",
          "</ul>",
        ];
      if (f.item === "reference")
        return [
          "<ul>",
          `  {${list}.map((item) =>`,
          "    item?.slug ? (",
          "      <li key={item._id}>",
          `        <Link href={\`/${f.name}/\${item.slug}\`}>{item.title ?? item.slug}</Link>`,
          "      </li>",
          "    ) : null,",
          "  )}",
          "</ul>",
        ];
      return comment(`is a list of ${f.item === "object" ? "objects" : `${f.item}s`}`);
    }
    case "object":
      return comment("is an object");
  }
}

function pageFile(shape: ContentShape, p: Plan, name: string, queryNames: Names): string {
  const fields = live(shape.fields);
  // The title is the heading and the slug field makes the address: neither is shown again.
  const shown = fields.filter((f) => f !== p.title && f !== p.route);
  const body = shown.flatMap((f) => show(f, shape));
  const usesImage = shown.some((f) => f.kind === "image" && !f.mixed);
  const usesLink = shown.some(
    (f) => !f.mixed && (f.kind === "reference" || (f.kind === "array" && f.item === "reference")),
  );
  const usesPortableText = shown.some((f) => f.kind === "portable-text" && !f.mixed);
  const optionalTitle = p.title !== undefined && p.title.present < shape.sampled;
  const title =
    p.title === undefined
      ? "slug"
      : optionalTitle
        ? `doc.${p.title.name} || slug`
        : `doc.${p.title.name}`;
  const description =
    p.description === undefined
      ? undefined
      : p.description.present < shape.sampled
        ? `doc.${p.description.name} || undefined`
        : `doc.${p.description.name}`;
  const image = p.image;
  const meta: string[] = [
    "  const { slug } = await params;",
    `  const doc = await client.fetch<${name} | null>(${queryNames.detail}, { slug });`,
    "  if (!doc) return {};",
    `  const title = ${title};`,
    ...(description === undefined ? [] : [`  const description = ${description};`]),
    "  const path = `${BASE_PATH}/${slug}`;",
  ];
  if (image !== undefined)
    meta.push(
      `  const image = doc.${image.name};`,
      "  const images = image?.url",
      "    ? [",
      "        {",
      "          url: image.url,",
      "          alt: image.alt,",
      "          width: image.width ?? undefined,",
      "          height: image.height ?? undefined,",
      "        },",
      "      ]",
      "    : undefined;",
    );
  const shared = [
    "title",
    ...(description === undefined ? [] : ["description"]),
    ...(image === undefined ? [] : ["images"]),
  ].join(", ");
  const card = image === undefined ? '"summary"' : 'images ? "summary_large_image" : "summary"';
  return `${[
    ...[
      'import type { Metadata } from "next";',
      ...(usesImage ? ['import Image from "next/image";'] : []),
      ...(usesLink ? ['import Link from "next/link";'] : []),
      'import { notFound } from "next/navigation";',
      ...(usesPortableText ? ['import { PortableText } from "@portabletext/react";'] : []),
      'import { client } from "@/sanity/lib/client";',
      `import { ${queryNames.detail}, ${queryNames.slugs} } from "./queries";`,
      `import type { ${name} } from "./types";`,
    ],
    "",
    header(shape),
    "// The canonical and share addresses below are paths, and Next.js resolves them against",
    "// metadataBase: set it in your root layout (app/layout.tsx), or the build stops and says so.",
    `// BASE_PATH is where this folder is served on your site; change it if it is not /${shape.type}.`,
    `const BASE_PATH = "/${shape.type}";`,
    ...(p.route === undefined
      ? ["// The address is the document id: this type has no slug field."]
      : []),
    "",
    "type Props = { params: Promise<{ slug: string }> };",
    "",
    "export async function generateStaticParams() {",
    `  const slugs = await client.fetch<string[]>(${queryNames.slugs});`,
    "  return slugs.map((slug) => ({ slug }));",
    "}",
    "",
    "export async function generateMetadata({ params }: Props): Promise<Metadata> {",
    ...meta,
    "  return {",
    "    title,",
    ...(description === undefined ? [] : ["    description,"]),
    "    alternates: { canonical: path },",
    `    openGraph: { type: "article", url: path, ${shared} },`,
    `    twitter: { card: ${card}, ${shared} },`,
    "  };",
    "}",
    "",
    `export default async function ${name}Page({ params }: Props) {`,
    "  const { slug } = await params;",
    `  const doc = await client.fetch<${name} | null>(${queryNames.detail}, { slug });`,
    "  if (!doc) notFound();",
    "  return (",
    "    <article>",
    `      <h1>{${title}}</h1>`,
    ...(body.length === 0 ? [] : [indent(body.join("\n"), 3)]),
    "    </article>",
    "  );",
    "}",
  ].join("\n")}\n`;
}

interface Names {
  list: string;
  slugs: string;
  detail: string;
}

/**
 * The three files of a route for one document type, written from its shape by templates: the same
 * shape gives the same text. `queries.ts` holds a list, a slug and a detail query (drafts left out,
 * only fields that are on the documents), `types.ts` one interface in which a field that is missing
 * on some documents is optional, and `page.tsx` the static params, the metadata (canonical, Open
 * Graph and Twitter), the image with its alt text, width and height, linked references and
 * Portable Text. Pure: no file is read or written here, so it can be tested without a folder and
 * shown before anything is written. A field or type name that is not a plain identifier is refused,
 * because it would be placed in code.
 */
export function scaffoldRoute(shape: ContentShape): GeneratedFile[] {
  if (!TYPE_NAME.test(shape.type))
    throw new Error(`${JSON.stringify(shape.type)} is not a Sanity document type name.`);
  if (shape.sampled === 0) throw new Error(`Nothing of type ${shape.type} exists.`);
  checkNames(shape.fields);
  const name = interfaceName(shape.type);
  const base = camel(name);
  const queryNames: Names = {
    list: `${base}ListQuery`,
    slugs: `${base}SlugsQuery`,
    detail: `${base}Query`,
  };
  const p = plan(live(shape.fields));
  const { entries, comments } = projection(shape, { imageSize: true });
  const listed = listedFields(p).map((f) => f.name);
  return [
    { name: "queries.ts", text: queriesFile(shape, p, entries, comments, queryNames) },
    { name: "types.ts", text: typesFile(shape, name, listed) },
    { name: "page.tsx", text: pageFile(shape, p, name, queryNames) },
  ];
}
