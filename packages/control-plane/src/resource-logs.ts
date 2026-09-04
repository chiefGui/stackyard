import { success, type Result } from "@stackyard/diagnostics";
import { Effect } from "effect";

export type ResourceLogStream = "stderr" | "stdout" | "system";
export type ResourceLogStatus = "complete" | "failed" | "live" | "removed";

export interface ResourceLogInput {
  readonly observedAt: number;
  readonly stream: ResourceLogStream;
  readonly text: string;
  readonly truncatedBytes?: number;
}

export interface ResourceLogEntry extends ResourceLogInput {
  readonly sequence: number;
}

export interface ResourceLogReadOptions {
  readonly after?: number;
  readonly limit?: number;
}

export interface ResourceLogSnapshot {
  readonly completion?: Result<void>;
  readonly droppedEntries: number;
  readonly entries: readonly ResourceLogEntry[];
  readonly hasMore: boolean;
  readonly latestCursor: number;
  readonly nextCursor: number;
  readonly retainedFrom: number;
  readonly revision: number;
  readonly status: ResourceLogStatus;
}

export interface ResourceLogSource {
  snapshot(options?: ResourceLogReadOptions): ResourceLogSnapshot;
  waitForChange(revision: number): Effect.Effect<void>;
}

export interface ResourceLogSink {
  write(entries: readonly ResourceLogInput[]): void;
}

export interface ResourceLogFeed extends ResourceLogSink, ResourceLogSource {
  complete(result?: Result<void>): void;
  hasObservedEntries(): boolean;
  remove(): void;
}

export interface ResourceLogStoreOptions {
  readonly maxBytesPerResource?: number;
  readonly maxEntriesPerResource?: number;
  readonly maxTotalBytes?: number;
  readonly maxTotalEntries?: number;
}

interface StoredEntry {
  readonly bytes: number;
  readonly entry: ResourceLogEntry;
}

interface GlobalEntry {
  readonly feed: BoundedResourceLogFeed;
  readonly sequence: number;
}

interface ResourceLogAccounting {
  add(feed: BoundedResourceLogFeed, stored: StoredEntry): void;
  release(stored: StoredEntry): void;
}

const defaultMaxBytesPerResource = 4 * 1024 * 1024;
const defaultMaxEntriesPerResource = 10_000;
const defaultMaxTotalBytes = 64 * 1024 * 1024;
const defaultMaxTotalEntries = 100_000;

export class ResourceLogStore {
  readonly #accounting: ResourceLogAccounting;
  readonly #entries: GlobalEntry[] = [];
  readonly #maxBytesPerResource: number;
  readonly #maxEntriesPerResource: number;
  readonly #maxTotalBytes: number;
  readonly #maxTotalEntries: number;
  #entryCursor = 0;
  #totalBytes = 0;
  #totalEntries = 0;

  constructor(options: ResourceLogStoreOptions = {}) {
    this.#maxTotalBytes = positiveInteger(
      options.maxTotalBytes,
      defaultMaxTotalBytes,
      "maxTotalBytes",
    );
    this.#maxTotalEntries = positiveInteger(
      options.maxTotalEntries,
      defaultMaxTotalEntries,
      "maxTotalEntries",
    );
    this.#maxBytesPerResource = Math.min(
      positiveInteger(
        options.maxBytesPerResource,
        defaultMaxBytesPerResource,
        "maxBytesPerResource",
      ),
      this.#maxTotalBytes,
    );
    this.#maxEntriesPerResource = Math.min(
      positiveInteger(
        options.maxEntriesPerResource,
        defaultMaxEntriesPerResource,
        "maxEntriesPerResource",
      ),
      this.#maxTotalEntries,
    );
    this.#accounting = {
      add: (feed, stored) => this.#add(feed, stored),
      release: (stored) => this.#release(stored),
    };
  }

  createFeed(): ResourceLogFeed {
    return new BoundedResourceLogFeed(
      this.#accounting,
      this.#maxBytesPerResource,
      this.#maxEntriesPerResource,
    );
  }

  #add(feed: BoundedResourceLogFeed, stored: StoredEntry): void {
    this.#entries.push({ feed, sequence: stored.entry.sequence });
    this.#totalBytes += stored.bytes;
    this.#totalEntries += 1;
    this.#enforceLimits();
    this.#compactEntriesIfNeeded();
  }

  #release(stored: StoredEntry): void {
    this.#totalBytes -= stored.bytes;
    this.#totalEntries -= 1;
  }

  #enforceLimits(): void {
    while (this.#totalBytes > this.#maxTotalBytes || this.#totalEntries > this.#maxTotalEntries) {
      const oldest = this.#entries[this.#entryCursor];
      this.#entryCursor += 1;
      if (!oldest) {
        throw new Error("Resource log accounting lost its oldest entry.");
      }
      oldest.feed.evict(oldest.sequence);
    }
  }

  #compactEntriesIfNeeded(): void {
    const queued = this.#entries.length - this.#entryCursor;
    if (queued <= this.#maxTotalEntries * 2 && this.#entryCursor * 2 < this.#entries.length) {
      return;
    }
    const retained = this.#entries
      .slice(this.#entryCursor)
      .filter(({ feed, sequence }) => feed.has(sequence));
    this.#entries.length = 0;
    this.#entries.push(...retained);
    this.#entryCursor = 0;
  }
}

class BoundedResourceLogFeed implements ResourceLogFeed {
  #entries: (StoredEntry | undefined)[] = [];
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #accounting: ResourceLogAccounting;
  readonly #waiters = new Set<() => void>();
  #bytes = 0;
  #completion: Result<void> | undefined;
  #head = 0;
  #nextSequence = 1;
  #revision = 0;
  #size = 0;
  #status: ResourceLogStatus = "live";

  constructor(accounting: ResourceLogAccounting, maxBytes: number, maxEntries: number) {
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
    this.#accounting = accounting;
  }

  write(entries: readonly ResourceLogInput[]): void {
    if (this.#status !== "live") {
      throw new Error("Cannot write to a completed resource log feed.");
    }
    if (entries.length === 0) {
      return;
    }

    for (const input of entries) {
      const retained = retainText(input.text, this.#maxBytes);
      const entry = Object.freeze({
        observedAt: input.observedAt,
        sequence: this.#nextSequence,
        stream: input.stream,
        text: retained.text,
        ...(input.truncatedBytes || retained.truncatedBytes
          ? { truncatedBytes: (input.truncatedBytes ?? 0) + retained.truncatedBytes }
          : {}),
      });
      this.#nextSequence += 1;
      while (
        this.#size > 0 &&
        (this.#size === this.#maxEntries || this.#bytes + retained.bytes > this.#maxBytes)
      ) {
        this.#evictOldest();
      }
      if (this.#size === this.#entries.length) {
        this.#grow();
      }
      const stored = Object.freeze({ bytes: retained.bytes, entry });
      const index = (this.#head + this.#size) % this.#entries.length;
      this.#entries[index] = stored;
      this.#size += 1;
      this.#bytes += stored.bytes;
      this.#accounting.add(this, stored);
    }
    this.#changed();
  }

  complete(result: Result<void> = success(undefined)): void {
    if (this.#status !== "live") {
      return;
    }
    this.#completion = result;
    this.#status = result.success ? "complete" : "failed";
    this.#changed();
  }

  hasObservedEntries(): boolean {
    return this.#nextSequence > 1;
  }

  remove(): void {
    if (this.#status === "removed") {
      return;
    }
    while (this.#size > 0) {
      this.#evictOldest();
    }
    this.#completion = undefined;
    this.#status = "removed";
    this.#changed();
  }

  snapshot(options: ResourceLogReadOptions = {}): ResourceLogSnapshot {
    const after = nonNegativeInteger(options.after, 0, "after");
    const limit = positiveInteger(options.limit, this.#maxEntries, "limit");
    const retainedFrom = this.#first()?.entry.sequence ?? this.#nextSequence;
    const entries: ResourceLogEntry[] = [];
    let hasMore = false;
    const startOffset = Math.min(this.#size, Math.max(0, after - retainedFrom + 1));

    for (let offset = startOffset; offset < this.#size; offset += 1) {
      const stored = this.#entries[(this.#head + offset) % this.#entries.length];
      if (!stored) {
        continue;
      }
      if (entries.length === limit) {
        hasMore = true;
        break;
      }
      entries.push(stored.entry);
    }

    return Object.freeze({
      ...(this.#completion ? { completion: this.#completion } : {}),
      droppedEntries: Math.max(0, retainedFrom - after - 1),
      entries: Object.freeze(entries),
      hasMore,
      latestCursor: this.#nextSequence - 1,
      nextCursor: entries.at(-1)?.sequence ?? Math.max(after, retainedFrom - 1),
      retainedFrom,
      revision: this.#revision,
      status: this.#status,
    });
  }

  waitForChange(revision: number): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      if (revision !== this.#revision) {
        resume(Effect.void);
        return Effect.void;
      }
      let active = true;
      const waiter = (): void => {
        if (!active) {
          return;
        }
        active = false;
        this.#waiters.delete(waiter);
        resume(Effect.void);
      };
      this.#waiters.add(waiter);
      if (revision !== this.#revision) {
        waiter();
      }
      return Effect.sync(() => {
        active = false;
        this.#waiters.delete(waiter);
      });
    });
  }

  has(sequence: number): boolean {
    const first = this.#first()?.entry.sequence;
    return first !== undefined && sequence >= first && sequence < first + this.#size;
  }

  evict(sequence: number): void {
    if (this.#first()?.entry.sequence === sequence) {
      this.#evictOldest();
      this.#changed();
    }
  }

  #changed(): void {
    this.#revision += 1;
    for (const waiter of this.#waiters) {
      waiter();
    }
  }

  #evictOldest(): void {
    const stored = this.#first();
    if (!stored) {
      return;
    }
    this.#entries[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#entries.length;
    this.#size -= 1;
    this.#bytes -= stored.bytes;
    this.#accounting.release(stored);
  }

  #first(): StoredEntry | undefined {
    return this.#size > 0 ? this.#entries[this.#head] : undefined;
  }

  #grow(): void {
    const capacity = Math.min(this.#maxEntries, Math.max(16, this.#entries.length * 2));
    const entries = Array.from<StoredEntry | undefined>({ length: capacity });
    for (let offset = 0; offset < this.#size; offset += 1) {
      entries[offset] = this.#entries[(this.#head + offset) % this.#entries.length];
    }
    this.#entries = entries;
    this.#head = 0;
  }
}

function retainText(
  text: string,
  maxBytes: number,
): {
  readonly bytes: number;
  readonly text: string;
  readonly truncatedBytes: number;
} {
  let bytes = 0;
  let retainedBytes = 0;
  let retainedCodeUnits = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes =
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    bytes += codePointBytes;
    if (bytes <= maxBytes) {
      retainedBytes = bytes;
      retainedCodeUnits = index + codeUnits;
    }
    index += codeUnits;
  }
  return {
    bytes: retainedBytes,
    text: retainedCodeUnits === text.length ? text : text.slice(0, retainedCodeUnits),
    truncatedBytes: bytes - retainedBytes,
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}
