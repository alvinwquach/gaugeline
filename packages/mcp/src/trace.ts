/**
 * The MCP server's trace (AG-05, ADR-0014 "every agent call is traced"): one JSON line per tool call, in the
 * shared record shape (`agentTraceRecord` in core): ids, SHA-256 hashes of the redacted arguments and
 * result, whole-millisecond latency, tokens and cost (0: no tool runs a model), the decision and the
 * policy's reason. Never the arguments, the page text or a URL.
 *
 * The server writes no file (no-write.test.ts): the sink is injectable, and the one the command line offers
 * (--trace) writes the lines to stderr, the server's log stream, for the operator to keep where they like.
 * Off by default. Failure-safe and off the call's path: a line is written after the call is answered, a
 * write that throws is counted and dropped, and a stream that cannot keep up drops lines (counted) past a
 * byte cap instead of buffering memory without end.
 */
import { type AgentTraceRecord, traceLine } from "@gaugeline/core";

export interface TraceSink {
  /** Must not throw; the server also catches anything it throws. */
  write(record: AgentTraceRecord): void;
}

export interface StreamTraceSink extends TraceSink {
  stats(): { written: number; failed: number; dropped: number };
}

/** What the sink needs of a stream: write, and (when the stream has it) how much it holds unsent. */
export interface TraceStream {
  write(chunk: string): unknown;
  readonly writableLength?: number;
}

/** Bytes a stream may hold unsent before trace lines are dropped (default 1 MiB). */
export const DEFAULT_TRACE_BUFFER_BYTES = 1024 * 1024;

export function createStreamTraceSink(
  stream: TraceStream,
  options: { maxBufferedBytes?: number } = {},
): StreamTraceSink {
  const cap = options.maxBufferedBytes ?? DEFAULT_TRACE_BUFFER_BYTES;
  let written = 0;
  let failed = 0;
  let dropped = 0;
  return {
    write(record) {
      try {
        if ((stream.writableLength ?? 0) > cap) {
          dropped++;
          return;
        }
        stream.write(traceLine(record));
        written++;
      } catch {
        failed++;
      }
    },
    stats: () => ({ written, failed, dropped }),
  };
}
