import type { SessionStore } from "./tabs.ts";

const KEY = "storageFull";

/** A `QuotaExceededError`, also as the cause of another error, such as pi-durable's `SessionFailed`. */
export function isStorageFull(error: unknown): boolean {
	let cause = error;
	for (let depth = 0; depth < 5 && typeof cause === "object" && cause !== null; depth += 1) {
		if ((cause as { name?: unknown }).name === "QuotaExceededError") return true;
		cause = (cause as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Whether Chrome refused a write because the extension's storage is full (design 8), shown as a banner in the panel.
 * Kept in `storage.session`, so it outlives the worker, which Chrome stops after about 30 s idle. Delete all chats, or a
 * send or Retry that was saved, from the panel or a gesture, clears it: space was freed, or writes go through again;
 * a full disk noted while it ran keeps it. Remove from History does not:
 * it only hides a chat (design 6.30).
 */
export class StorageFull {
	#full = false;
	/** Set by `note()` and `clear()`: a `load()` that ends later keeps their value. */
	#decided = false;
	/** The stored value was read, or decided since: before that, `full` can be false while the store says full. */
	#known = false;
	/** Full disks noted, so a clear for a write that went through does not hide a failure noted since it began. */
	#notes = 0;
	#line: Promise<void> = Promise.resolve();
	readonly #store: SessionStore;
	readonly #changed: () => void;

	constructor(store: SessionStore, changed: () => void) {
		this.#store = store;
		this.#changed = changed;
	}

	get full(): boolean {
		return this.#full;
	}

	async load(): Promise<void> {
		const stored = (await this.#store.get(KEY))[KEY] === true;
		if (!this.#decided) this.#set(stored);
		this.#known = true;
	}

	/** Records a failed write when the disk is full; any other error changes nothing. */
	note(error: unknown): Promise<void> {
		if (!isStorageFull(error)) return Promise.resolve();
		this.#notes += 1;
		return this.#save(true);
	}

	/** Taken when a write begins, for `clear()` once it went through. */
	mark(): number {
		return this.#notes;
	}

	/** Writes go through again; with `since`, unless a full disk was noted after that `mark()`. */
	clear(since?: number): Promise<void> {
		if (since !== undefined && since !== this.#notes) return Promise.resolve();
		// A worker a gesture woke has not read the stored value yet: write it anyway.
		return this.#full || !this.#known ? this.#save(false) : Promise.resolve();
	}

	#save(full: boolean): Promise<void> {
		this.#decided = true;
		this.#known = true;
		this.#set(full);
		// Saves in call order; a failed save leaves the value for this worker's lifetime.
		this.#line = this.#line.then(() => this.#store.set({ [KEY]: full }).catch(() => {}));
		return this.#line;
	}

	#set(full: boolean): void {
		if (full === this.#full) return;
		this.#full = full;
		this.#changed();
	}
}
