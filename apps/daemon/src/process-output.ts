import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type Result,
} from "@stackyard/diagnostics";
import type { ProcessLogLine, ProcessLogSink } from "@stackyard/control-plane";

export const maxProcessLogLineBytes = 256 * 1024;

export interface ProcessLogCaptureOptions {
  readonly maxLineBytes?: number;
  readonly signal?: AbortSignal;
}

interface FramedLine {
  readonly text: string;
  readonly truncatedBytes?: number;
}

interface DecodedBytes {
  readonly bytes: number;
  readonly text: string;
}

const decoder = new TextDecoder();
const publishBatchSize = 256;

export async function captureProcessLogs(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  sink: ProcessLogSink,
  options: ProcessLogCaptureOptions = {},
): Promise<Result<void>> {
  const maxLineBytes = options.maxLineBytes ?? maxProcessLogLineBytes;
  const captured = await Promise.allSettled([
    captureStream(stdout, "stdout", sink, maxLineBytes, options.signal),
    captureStream(stderr, "stderr", sink, maxLineBytes, options.signal),
  ]);
  const errors = captured.flatMap((result) =>
    result.status === "rejected" ? [describeError(result.reason)] : [],
  );
  return errors.length === 0
    ? success(undefined)
    : failure(
        createDiagnostic({
          code: "SYD4008",
          help: "Restart the service. If the problem persists, check its output streams.",
          message: "Service output could not be captured.",
          notes: errors,
        }),
      );
}

async function captureStream(
  stream: ReadableStream<Uint8Array>,
  name: "stderr" | "stdout",
  sink: ProcessLogSink,
  maxLineBytes: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const reader = stream.getReader();
  const framer = new BoundedLineFramer(maxLineBytes);
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    cancel();
  } else {
    signal?.addEventListener("abort", cancel, { once: true });
  }
  try {
    while (true) {
      /* oxlint-disable-next-line eslint/no-await-in-loop -- A single stream must be drained in order. */
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      framer.push(chunk.value, (lines) => publish(lines, name, sink));
    }
    const finalLine = framer.finish();
    if (finalLine) {
      publish([finalLine], name, sink);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function publish(
  lines: readonly FramedLine[],
  stream: "stderr" | "stdout",
  sink: ProcessLogSink,
): void {
  if (lines.length === 0) {
    return;
  }
  const observedAt = Date.now();
  sink.write(
    lines.map((line): ProcessLogLine =>
      Object.freeze({
        observedAt,
        stream,
        text: line.text,
        ...(line.truncatedBytes ? { truncatedBytes: line.truncatedBytes } : {}),
      }),
    ),
  );
}

class BoundedLineFramer {
  readonly #line: BoundedLine;
  #skipLineFeed = false;

  constructor(maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer.");
    }
    this.#line = new BoundedLine(maxLineBytes);
  }

  push(chunk: Uint8Array, emitBatch: (lines: readonly FramedLine[]) => void): void {
    let lines: FramedLine[] = [];
    let offset = 0;
    if (this.#skipLineFeed) {
      if (chunk.byteLength === 0) {
        return;
      }
      if (chunk[0] === 0x0a) {
        offset = 1;
      }
      this.#skipLineFeed = false;
    }

    while (offset < chunk.byteLength) {
      let delimiter = offset;
      while (
        delimiter < chunk.byteLength &&
        chunk[delimiter] !== 0x0a &&
        chunk[delimiter] !== 0x0d
      ) {
        delimiter += 1;
      }
      this.#line.append(chunk.subarray(offset, delimiter));
      if (delimiter === chunk.byteLength) {
        break;
      }

      const byte = chunk[delimiter];
      lines.push(this.#line.take());
      if (lines.length === publishBatchSize) {
        emitBatch(lines);
        lines = [];
      }
      offset = delimiter + 1;
      if (byte === 0x0d) {
        if (chunk[offset] === 0x0a) {
          offset += 1;
        } else if (offset === chunk.byteLength) {
          this.#skipLineFeed = true;
        }
      }
    }
    emitBatch(lines);
  }

  finish(): FramedLine | undefined {
    return this.#line.hasBytes ? this.#line.take() : undefined;
  }
}

class BoundedLine {
  readonly #prefixLimit: number;
  readonly #suffixLimit: number;
  #prefix = new Uint8Array();
  #prefixLength = 0;
  #suffix: Uint8Array | undefined;
  #suffixLength = 0;
  #suffixStart = 0;
  #totalBytes = 0;

  constructor(maxBytes: number) {
    this.#prefixLimit = Math.ceil(maxBytes / 2);
    this.#suffixLimit = maxBytes - this.#prefixLimit;
  }

  get hasBytes(): boolean {
    return this.#totalBytes > 0;
  }

  append(bytes: Uint8Array): void {
    this.#totalBytes += bytes.byteLength;
    const prefixBytes = Math.min(bytes.byteLength, this.#prefixLimit - this.#prefixLength);
    if (prefixBytes > 0) {
      this.#appendPrefix(bytes.subarray(0, prefixBytes));
    }
    if (prefixBytes < bytes.byteLength && this.#suffixLimit > 0) {
      this.#appendSuffix(bytes.subarray(prefixBytes));
    }
  }

  take(): FramedLine {
    const prefix = this.#prefix.subarray(0, this.#prefixLength);
    const suffix = this.#readSuffix();
    const omitted = this.#totalBytes - prefix.byteLength - suffix.byteLength;
    const decodedPrefix = omitted > 0 ? decodePrefix(prefix) : undefined;
    const decodedSuffix = omitted > 0 ? decodeSuffix(suffix) : undefined;
    const truncatedBytes =
      omitted > 0 && decodedPrefix && decodedSuffix
        ? this.#totalBytes - decodedPrefix.bytes - decodedSuffix.bytes
        : 0;
    const text =
      decodedPrefix && decodedSuffix
        ? `${decodedPrefix.text}… ${truncatedBytes} bytes omitted …${decodedSuffix.text}`
        : decoder.decode(suffix.byteLength === 0 ? prefix : join(prefix, suffix));
    this.#prefixLength = 0;
    this.#suffixLength = 0;
    this.#suffixStart = 0;
    this.#totalBytes = 0;
    return Object.freeze({
      text,
      ...(truncatedBytes > 0 ? { truncatedBytes } : {}),
    });
  }

  #appendPrefix(bytes: Uint8Array): void {
    const required = this.#prefixLength + bytes.byteLength;
    if (this.#prefix.byteLength < required) {
      const capacity = Math.min(
        this.#prefixLimit,
        Math.max(required, Math.max(64, this.#prefix.byteLength * 2)),
      );
      const grown = new Uint8Array(capacity);
      grown.set(this.#prefix.subarray(0, this.#prefixLength));
      this.#prefix = grown;
    }
    this.#prefix.set(bytes, this.#prefixLength);
    this.#prefixLength = required;
  }

  #appendSuffix(bytes: Uint8Array): void {
    if (!this.#suffix) {
      this.#suffix = new Uint8Array(this.#suffixLimit);
    }
    if (bytes.byteLength >= this.#suffixLimit) {
      this.#suffix.set(bytes.subarray(bytes.byteLength - this.#suffixLimit));
      this.#suffixLength = this.#suffixLimit;
      this.#suffixStart = 0;
      return;
    }

    const writeAt = (this.#suffixStart + this.#suffixLength) % this.#suffixLimit;
    const first = Math.min(bytes.byteLength, this.#suffixLimit - writeAt);
    this.#suffix.set(bytes.subarray(0, first), writeAt);
    this.#suffix.set(bytes.subarray(first), 0);
    const overflow = Math.max(0, this.#suffixLength + bytes.byteLength - this.#suffixLimit);
    this.#suffixStart = (this.#suffixStart + overflow) % this.#suffixLimit;
    this.#suffixLength = Math.min(this.#suffixLimit, this.#suffixLength + bytes.byteLength);
  }

  #readSuffix(): Uint8Array {
    if (!this.#suffix || this.#suffixLength === 0) {
      return new Uint8Array();
    }
    const output = new Uint8Array(this.#suffixLength);
    const first = Math.min(this.#suffixLength, this.#suffixLimit - this.#suffixStart);
    output.set(this.#suffix.subarray(this.#suffixStart, this.#suffixStart + first));
    output.set(this.#suffix.subarray(0, this.#suffixLength - first), first);
    return output;
  }
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function decodePrefix(bytes: Uint8Array): DecodedBytes {
  const end = completeUtf8PrefixLength(bytes);
  return { bytes: end, text: decoder.decode(bytes.subarray(0, end)) };
}

function decodeSuffix(bytes: Uint8Array): DecodedBytes {
  let start = 0;
  while (start < Math.min(3, bytes.byteLength) && isUtf8Continuation(bytes[start])) {
    start += 1;
  }
  return { bytes: bytes.byteLength - start, text: decoder.decode(bytes.subarray(start)) };
}

function completeUtf8PrefixLength(bytes: Uint8Array): number {
  let lead = bytes.byteLength - 1;
  while (lead >= 0 && bytes.byteLength - lead <= 4 && isUtf8Continuation(bytes[lead])) {
    lead -= 1;
  }
  if (lead < 0) {
    return 0;
  }
  const available = bytes.byteLength - lead;
  return utf8SequenceLength(bytes[lead]) > available ? lead : bytes.byteLength;
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(byte: number | undefined): number {
  if (byte === undefined || (byte & 0x80) === 0) {
    return 1;
  }
  if ((byte & 0xe0) === 0xc0) {
    return 2;
  }
  if ((byte & 0xf0) === 0xe0) {
    return 3;
  }
  if ((byte & 0xf8) === 0xf0) {
    return 4;
  }
  return 1;
}
