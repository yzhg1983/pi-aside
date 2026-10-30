import type { AttachedPage } from "../shared/protocol.ts";

const KEY = "tabs";

/** The part of `chrome.storage.session` used here. */
export type SessionStore = {
	get(key: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
};

/** What a tab holds (design 6.17). */
export type TabEntry = {
	/** The tab's chat; null while fresh; absent while unresolved, until rule 2 ran. */
	chat?: number | null;
	/** Counts New chat and History in this tab; creating a fresh tab's chat does not change it. */
	rev: number;
	/** The start time of a chat that rule 2 found, until the tab's next send. */
	resumed: number | null;
	/** Of the tab's newest gesture or New chat capture: the full top-level URL, also used for a pending lookup. */
	url: string | null;
	/** Whether the capture found the URL's fragment as an element in the page; null when it could not check. */
	anchor: boolean | null;
	/** The page captured at a gesture or New chat, if readable, with its key: what a typed message attaches. */
	page: AttachedPage | null;
};

/** A tab no gesture has resolved yet. */
export const UNRESOLVED: TabEntry = { rev: 0, resumed: null, url: null, anchor: null, page: null };

/**
 * Per tab, its chat and its newest page capture, kept in `storage.session`, which a browser restart and an extension
 * update empty. Changes wait for the saved entries to load and run one at a time, each against the entries as they are then:
 * a worker that just started must not save its partial map over the other tabs, and a late page write must not undo a
 * newer chat.
 */
export class Tabs {
	readonly #entries = new Map<number, TabEntry>();
	readonly #captureVersions = new Map<number, number>();
	readonly #store: SessionStore;
	readonly #changed: () => void;
	#loaded: Promise<void> | undefined;
	#line: Promise<unknown> = Promise.resolve();

	constructor(store: SessionStore, changed: () => void) {
		this.#store = store;
		this.#changed = changed;
	}

	/** As loaded so far: undefined until `load()` resolves. */
	get(tabId: number): TabEntry | undefined {
		return this.#entries.get(tabId);
	}

	entries(): IterableIterator<[number, TabEntry]> {
		return this.#entries.entries();
	}

	/** Worker-local capture fence. Unlike `rev`, it is not inherited when Chrome replaces a tab. */
	captureVersion(tabId: number): number {
		return this.#captureVersions.get(tabId) ?? 0;
	}

	/** Called after a successful New chat or History switch, before the next tab write runs. */
	invalidateCaptures(tabId: number): void {
		this.#captureVersions.set(tabId, this.captureVersion(tabId) + 1);
	}

	/** Loads the saved entries once; a failed load is tried again by the next caller. */
	load(): Promise<void> {
		if (this.#loaded === undefined) {
			const loading = this.#store.get(KEY).then((stored) => {
				const saved = (stored[KEY] ?? {}) as Record<string, TabEntry>;
				for (const [tabId, entry] of Object.entries(saved)) this.#entries.set(Number(tabId), entry);
				this.#changed();
			});
			this.#loaded = loading;
			loading.catch(() => {
				if (this.#loaded === loading) this.#loaded = undefined;
			});
		}
		return this.#loaded;
	}

	/** Applies `change` to the loaded entries and saves them. A change that throws saves nothing. */
	update(change: (entries: Map<number, TabEntry>) => void): Promise<void> {
		const next = this.#line.then(async () => {
			await this.load();
			const changed = new Map(this.#entries);
			change(changed);
			await this.#store.set({ [KEY]: Object.fromEntries(changed) });
			this.#entries.clear();
			for (const [tabId, entry] of changed) this.#entries.set(tabId, entry);
			for (const tabId of this.#captureVersions.keys()) {
				if (!changed.has(tabId)) this.#captureVersions.delete(tabId);
			}
			this.#changed();
		});
		this.#line = next.catch(() => {});
		return next;
	}

	/** Changes one tab's entry: `change` gets the current one, or `UNRESOLVED`. */
	set(tabId: number, change: (entry: TabEntry) => TabEntry): Promise<void> {
		return this.update((entries) => entries.set(tabId, change(entries.get(tabId) ?? UNRESOLVED)));
	}
}
