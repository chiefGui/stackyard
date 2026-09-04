import { Effect, Schema, Stream } from "effect";

const maximumCapturedOutputBytes = 64 * 1024;

export interface CapturedProcessOutput {
  readonly text: string;
  readonly truncated: boolean;
}

export class ProcessOutputCaptureError extends Schema.TaggedError<ProcessOutputCaptureError>()(
  "ProcessOutputCaptureError",
  { cause: Schema.Defect() },
) {}

export const captureProcessOutput = Effect.fn("captureProcessOutput")(function* (
  stream: ReadableStream<Uint8Array>,
  maximumBytes = maximumCapturedOutputBytes,
): Effect.fn.Return<CapturedProcessOutput, ProcessOutputCaptureError> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("Maximum captured output must be a positive safe integer.");
  }

  const retained = new Uint8Array(maximumBytes);
  let retainedBytes = 0;
  let truncated = false;

  yield* Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (cause) => new ProcessOutputCaptureError({ cause }),
  }).pipe(
    Stream.runForEach((value) =>
      Effect.sync(() => {
        const remaining = maximumBytes - retainedBytes;
        const bytesToRetain = Math.min(remaining, value.byteLength);

        if (bytesToRetain > 0) {
          retained.set(value.subarray(0, bytesToRetain), retainedBytes);
          retainedBytes += bytesToRetain;
        }

        if (bytesToRetain < value.byteLength) {
          truncated = true;
        }
      }),
    ),
  );

  return Object.freeze({
    text: new TextDecoder().decode(retained.subarray(0, retainedBytes)),
    truncated,
  });
});

export function emptyCapturedProcessOutput(): CapturedProcessOutput {
  return emptyOutput;
}

const emptyOutput: CapturedProcessOutput = Object.freeze({
  text: "",
  truncated: false,
});
