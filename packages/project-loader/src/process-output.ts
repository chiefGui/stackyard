const maximumCapturedOutputBytes = 64 * 1024;

export interface CapturedProcessOutput {
  readonly text: string;
  readonly truncated: boolean;
}

export async function captureProcessOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes = maximumCapturedOutputBytes,
): Promise<CapturedProcessOutput> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("Maximum captured output must be a positive safe integer.");
  }

  const retained = new Uint8Array(maximumBytes);
  const reader = stream.getReader();
  let retainedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      // Reads must remain sequential to preserve stream backpressure.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remaining = maximumBytes - retainedBytes;
      const bytesToRetain = Math.min(remaining, value.byteLength);

      if (bytesToRetain > 0) {
        retained.set(value.subarray(0, bytesToRetain), retainedBytes);
        retainedBytes += bytesToRetain;
      }

      if (bytesToRetain < value.byteLength) {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Object.freeze({
    text: new TextDecoder().decode(retained.subarray(0, retainedBytes)),
    truncated,
  });
}

export function emptyCapturedProcessOutput(): CapturedProcessOutput {
  return emptyOutput;
}

const emptyOutput: CapturedProcessOutput = Object.freeze({
  text: "",
  truncated: false,
});
