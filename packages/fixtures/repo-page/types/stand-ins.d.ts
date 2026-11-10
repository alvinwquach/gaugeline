/**
 * Stand-ins for the four packages a generated route imports, so that `tsc --noEmit` can check it
 * without installing Next.js, React or Sanity into this repository (Next.js alone is over 100 MB
 * with its platform binaries). They are cut down from the published type declarations of next
 * 16.4.6, @portabletext/react 8.0.1 and groq 6.23.0, and keep their signatures for the parts the
 * generated files use: a misspelled prop, a missing `alt` or a missing `await params` fails here
 * as it would in a real project. Nothing here runs.
 */

declare namespace JSX {
  interface Element {
    readonly __element: true;
  }
  interface IntrinsicAttributes {
    key?: string | number | bigint | null | undefined;
  }
  interface IntrinsicElements {
    [tag: string]: { [attribute: string]: unknown };
  }
}

declare module "next" {
  // next/dist/lib/metadata/types/alternative-urls-types.d.ts
  type AlternateURLs = {
    canonical?: null | string | URL | undefined;
  };
  // .../opengraph-types.d.ts
  type OGImageDescriptor = {
    url: string | URL;
    secureUrl?: string | URL | undefined;
    alt?: string | undefined;
    type?: string | undefined;
    width?: string | number | undefined;
    height?: string | number | undefined;
  };
  type OGImage = string | OGImageDescriptor | URL;
  type OpenGraphMetadata = {
    title?: string | undefined;
    description?: string | undefined;
    siteName?: string | undefined;
    images?: OGImage | Array<OGImage> | undefined;
    url?: null | string | URL | undefined;
  };
  type OpenGraph =
    | (OpenGraphMetadata & { type: "website" })
    | (OpenGraphMetadata & {
        type: "article";
        publishedTime?: string | undefined;
        modifiedTime?: string | undefined;
        tags?: null | string | Array<string> | undefined;
      });
  // .../twitter-types.d.ts
  type TwitterImageDescriptor = {
    url: string | URL;
    alt?: string | undefined;
    secureUrl?: string | URL | undefined;
    type?: string | undefined;
    width?: string | number | undefined;
    height?: string | number | undefined;
  };
  type TwitterImage = string | TwitterImageDescriptor | URL;
  type TwitterMetadata = {
    description?: null | string | undefined;
    title?: string | undefined;
    images?: TwitterImage | Array<TwitterImage> | undefined;
  };
  type Twitter =
    (TwitterMetadata & { card: "summary" }) | (TwitterMetadata & { card: "summary_large_image" });
  // .../metadata-interface.d.ts
  interface Metadata {
    metadataBase?: null | URL | undefined;
    title?: null | string | undefined;
    description?: null | string | undefined;
    alternates?: AlternateURLs | null | undefined;
    openGraph?: OpenGraph | null | undefined;
    twitter?: Twitter | null | undefined;
  }
}

declare module "next/image" {
  // next/dist/shared/lib/get-img-props.d.ts, without the attributes it takes from <img>.
  type ImageProps = {
    src: string;
    alt: string;
    width?: number | `${number}`;
    height?: number | `${number}`;
    fill?: boolean;
    quality?: number | `${number}`;
    priority?: boolean;
    sizes?: string;
    className?: string;
  };
  export default function Image(props: ImageProps): JSX.Element;
}

declare module "next/link" {
  type LinkProps = { href: string; prefetch?: boolean; children?: unknown };
  export default function Link(props: LinkProps): JSX.Element;
}

declare module "next/navigation" {
  export function notFound(): never;
}

declare module "@portabletext/react" {
  // @portabletext/types: a block is a typed object; the rest of its shape is the editor's.
  export interface PortableTextBlock {
    _type: string;
    _key?: string;
    [key: string]: unknown;
  }
  export interface PortableTextProps {
    value: PortableTextBlock | PortableTextBlock[] | null | undefined;
  }
  export function PortableText(props: PortableTextProps): JSX.Element;
}

declare module "groq" {
  export default function groq(strings: TemplateStringsArray, ...keys: unknown[]): string;
}
