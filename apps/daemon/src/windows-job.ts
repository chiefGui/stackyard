import { dlopen, type Library, type Pointer } from "bun:ffi";

const jobObjectExtendedLimitInformation = 9;
const jobObjectLimitKillOnClose = 0x0000_2000;
const processSetQuota = 0x0100;
const processTerminate = 0x0001;
const extendedLimitInformationBytes = 144;
const limitFlagsOffset = 16;

const definitions = {
  AssignProcessToJobObject: {
    args: ["ptr", "ptr"],
    returns: "bool",
  },
  CloseHandle: {
    args: ["ptr"],
    returns: "bool",
  },
  CreateJobObjectW: {
    args: ["ptr", "ptr"],
    returns: "ptr",
  },
  GetLastError: {
    returns: "u32",
  },
  OpenProcess: {
    args: ["u32", "bool", "u32"],
    returns: "ptr",
  },
  SetInformationJobObject: {
    args: ["ptr", "u32", "ptr", "u32"],
    returns: "bool",
  },
  TerminateJobObject: {
    args: ["ptr", "u32"],
    returns: "bool",
  },
} as const;

type Kernel32 = Library<typeof definitions>;

export interface WindowsJob {
  terminate(): void;
}

let loadedKernel32: Kernel32 | undefined;

export function createWindowsJob(pid: number): WindowsJob {
  const kernel32 = getKernel32();
  const job = kernel32.symbols.CreateJobObjectW(null, null);
  if (!job) {
    throw lastWindowsError(kernel32, "CreateJobObjectW");
  }

  try {
    configureKillOnClose(kernel32, job);
    assignProcess(kernel32, job, pid);
  } catch (error) {
    if (!kernel32.symbols.CloseHandle(job)) {
      throw new AggregateError(
        [error, lastWindowsError(kernel32, "CloseHandle")],
        "Windows Job Object setup and cleanup both failed.",
        { cause: error },
      );
    }
    throw error;
  }

  let closed = false;
  return Object.freeze({
    terminate(): void {
      if (closed) {
        return;
      }
      if (!kernel32.symbols.TerminateJobObject(job, 1)) {
        throw lastWindowsError(kernel32, "TerminateJobObject");
      }
      if (!kernel32.symbols.CloseHandle(job)) {
        throw lastWindowsError(kernel32, "CloseHandle");
      }
      closed = true;
    },
  });
}

function configureKillOnClose(kernel32: Kernel32, job: Pointer | bigint): void {
  const information = new Uint8Array(extendedLimitInformationBytes);
  new DataView(information.buffer).setUint32(limitFlagsOffset, jobObjectLimitKillOnClose, true);
  if (
    !kernel32.symbols.SetInformationJobObject(
      job,
      jobObjectExtendedLimitInformation,
      information,
      information.byteLength,
    )
  ) {
    throw lastWindowsError(kernel32, "SetInformationJobObject");
  }
}

function assignProcess(kernel32: Kernel32, job: Pointer | bigint, pid: number): void {
  const processHandle = kernel32.symbols.OpenProcess(
    processSetQuota | processTerminate,
    false,
    pid,
  );
  if (!processHandle) {
    throw lastWindowsError(kernel32, "OpenProcess");
  }

  const assigned = kernel32.symbols.AssignProcessToJobObject(job, processHandle);
  const assignmentError = assigned
    ? undefined
    : lastWindowsError(kernel32, "AssignProcessToJobObject");
  const closed = kernel32.symbols.CloseHandle(processHandle);
  const closeError = closed ? undefined : lastWindowsError(kernel32, "CloseHandle");
  if (assignmentError && closeError) {
    throw new AggregateError(
      [assignmentError, closeError],
      "Windows process assignment and handle cleanup both failed.",
    );
  }
  if (assignmentError) {
    throw assignmentError;
  }
  if (closeError) {
    throw closeError;
  }
}

function getKernel32(): Kernel32 {
  loadedKernel32 ??= dlopen("kernel32.dll", definitions);
  return loadedKernel32;
}

function lastWindowsError(kernel32: Kernel32, operation: string): Error {
  return new Error(`${operation} failed with Windows error ${kernel32.symbols.GetLastError()}.`);
}
