import { describe, expect, test } from "bun:test";

import { captureProcessLogs } from "../apps/daemon/src/process-output.ts";
import type { ProcessLogLine } from "../packages/control-plane/src/index.ts";

const encoder = new TextEncoder();

describe("service output capture", () => {
  test("frames fragmented UTF-8, CRLF, empty, and unterminated lines", async () => {
    const encoded = encoder.encode("hé\r");
    const lines: ProcessLogLine[] = [];
    const captured = await captureProcessLogs(
      stream([
        encoded.subarray(0, 2),
        encoded.subarray(2),
        new Uint8Array(),
        encoder.encode("\n\nlast"),
      ]),
      stream([encoder.encode("first\rprogress\n")]),
      { write: (entries) => lines.push(...entries) },
    );

    expect(captured.success).toBeTrue();
    expect(lines.filter(({ stream: name }) => name === "stdout").map(({ text }) => text)).toEqual([
      "hé",
      "",
      "last",
    ]);
    expect(lines.filter(({ stream: name }) => name === "stderr").map(({ text }) => text)).toEqual([
      "first",
      "progress",
    ]);
  });

  test("retains the beginning and end of oversized lines with exact loss metadata", async () => {
    const lines: ProcessLogLine[] = [];
    const captured = await captureProcessLogs(
      stream([encoder.encode("abcdefghijklmnop\n")]),
      stream([]),
      { write: (entries) => lines.push(...entries) },
      { maxLineBytes: 10 },
    );

    expect(captured.success).toBeTrue();
    expect(lines).toEqual([
      {
        observedAt: expect.any(Number),
        stream: "stdout",
        text: "abcde… 6 bytes omitted …lmnop",
        truncatedBytes: 6,
      },
    ]);
  });

  test("does not publish broken UTF-8 at truncation boundaries", async () => {
    const lines: ProcessLogLine[] = [];
    const captured = await captureProcessLogs(
      stream([encoder.encode("1234🙂abcdefgh🙂9876\n")]),
      stream([]),
      { write: (entries) => lines.push(...entries) },
      { maxLineBytes: 12 },
    );

    expect(captured.success).toBeTrue();
    expect(lines[0]?.text).not.toContain("�");
    expect(lines[0]?.truncatedBytes).toBeGreaterThan(0);
  });

  test("reports sink failures only after both streams settle", async () => {
    let stderrDrained = false;
    let stderrReads = 0;
    const captured = await captureProcessLogs(
      stream([encoder.encode("stdout\n")]),
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stderrReads === 0) {
            stderrReads += 1;
            controller.enqueue(encoder.encode("stderr\n"));
          } else {
            stderrDrained = true;
            controller.close();
          }
        },
      }),
      {
        write(entries) {
          if (entries[0]?.stream === "stdout") {
            throw new Error("sink closed");
          }
        },
      },
    );

    expect(captured.success).toBeFalse();
    expect(stderrDrained).toBeTrue();
    if (!captured.success) {
      expect(captured.diagnostics[0].code).toBe("SYD4008");
    }
  });

  test("cancels both output pumps when process startup is abandoned", async () => {
    const cancellation = new AbortController();
    let canceledStreams = 0;
    const pendingStream = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        cancel() {
          canceledStreams += 1;
        },
        pull() {},
      });
    const capture = captureProcessLogs(
      pendingStream(),
      pendingStream(),
      { write() {} },
      { signal: cancellation.signal },
    );

    cancellation.abort();

    expect((await capture).success).toBeTrue();
    expect(canceledStreams).toBe(2);
  });
});

function stream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
