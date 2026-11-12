import type { DocumentsConfig } from "./config.js";

/** What a document reader says about a file: its text per page, or why it cannot be read. */
export type DocumentText =
  | { ok: true; pages: string[]; pageCount: number; truncated: boolean }
  | { ok: false; reason: string; message: string };

/**
 * Reads the text layer of a PDF. The implementation is the optional package @gaugeline/documents,
 * loaded only when installed (the published gaugeline package keeps no runtime dependencies).
 */
export interface DocumentReader {
  read(
    bytes: Uint8Array,
    limits?: { maxPages?: number; maxStreamBytes?: number; maxInflatedBytes?: number },
  ): DocumentText;
}

/** One price the site (or a system behind it) states, to compare a document with. Amounts are minor units. */
export interface ReferenceItem {
  name: string;
  /** normaliseName(name): the key shared with the product matcher. */
  key: string;
  amount: number;
  size?: string;
  /** In words, for the evidence: "your content system", "Stripe", "gaugeline.facts.json". */
  source: string;
}

/** What the document checks are given besides the pages. All of it is optional. */
export interface DocumentsContext {
  config?: DocumentsConfig;
  /** Replaces the optional package: for tests, and for a host that already has a reader. */
  reader?: DocumentReader;
  /** The prices the content system and the payment systems state, in priority order, read once. */
  reference?: () => Promise<ReferenceItem[]>;
}

export const INSTALL_HINT = "install @gaugeline/documents to read PDFs";

/** The optional package, or undefined when it is not installed (or does not look like the reader). */
export async function loadDocumentReader(): Promise<DocumentReader | undefined> {
  const name = "@gaugeline/documents";
  try {
    const mod = (await import(/* @vite-ignore */ name)) as { readPdf?: DocumentReader["read"] };
    const read = mod.readPdf;
    return typeof read === "function" ? { read } : undefined;
  } catch {
    return undefined;
  }
}
