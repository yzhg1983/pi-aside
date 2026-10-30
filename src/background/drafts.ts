import type { Draft } from "../shared/protocol.ts";

const DRAFTS_KEY = "drafts";

/**
 * Whether the user changed a draft's text before sending it. The panel trims what it sends, and a selection often ends
 * in a line break, so line endings and the ends are normalized first.
 */
export function draftEdited(sent: string, draft: string): boolean {
	const normal = (text: string) => text.replace(/\r\n?/g, "\n").trim();
	return normal(sent) !== normal(draft);
}
/** Per tab; adding one more, or moving a replaced tab's onto the new ID's, drops that tab's oldest. */
export const MAX_DRAFTS = 10;

/** `drafts` with at most `max` of tab `tabId`'s, the newest. Drafts are stored oldest first. */
function newest(drafts: readonly Draft[], tabId: number, max: number): readonly Draft[] {
	const same = drafts.filter((draft) => draft.tabId === tabId);
	const dropped = new Set(same.slice(0, Math.max(0, same.length - max)).map((draft) => draft.id));
	return dropped.size === 0 ? drafts : drafts.filter((draft) => !dropped.has(draft.id));
}

/**
 * Unsent text per tab, in `storage.session`: compose-mode selections, selection sends that failed before admission,
 * and inputs Stop withdrew from the queue. A browser restart drops them, as it drops anything not admitted.
 */
export class Drafts {
	readonly #changed: () => void;
	#drafts: readonly Draft[] = [];
	#loaded: Promise<void> | undefined;
	#writes: Promise<unknown> = Promise.resolve();

	constructor(changed: () => void) {
		this.#changed = changed;
	}

	load(): Promise<void> {
		if (this.#loaded === undefined) {
			const loading = chrome.storage.session.get(DRAFTS_KEY).then((stored) => {
				const value: unknown = stored[DRAFTS_KEY];
				this.#drafts = Array.isArray(value) ? (value as Draft[]) : [];
				this.#changed();
			});
			this.#loaded = loading;
			loading.catch(() => {
				if (this.#loaded === loading) this.#loaded = undefined;
			});
		}
		return this.#loaded;
	}

	forTab(tabId: number): Draft[] {
		return this.#drafts.filter((draft) => draft.tabId === tabId);
	}

	get(id: string): Draft | undefined {
		return this.#drafts.find((draft) => draft.id === id);
	}

	async add(fields: Omit<Draft, "id" | "createdAt">): Promise<Draft> {
		const draft: Draft = { ...fields, id: crypto.randomUUID(), createdAt: Date.now() };
		await this.#update((drafts) => [...newest(drafts, draft.tabId, MAX_DRAFTS - 1), draft]);
		return draft;
	}

	remove(id: string): Promise<void> {
		return this.#update((drafts) => drafts.filter((draft) => draft.id !== id));
	}

	/** Every tab's drafts go: Delete all chats (design 6.31); they can hold selections and pages. */
	clear(): Promise<void> {
		return this.#update(() => []);
	}

	removeTab(tabId: number): Promise<void> {
		return this.#update((drafts) => drafts.filter((draft) => draft.tabId !== tabId));
	}

	/**
	 * Chrome replaced the tab's contents and gave it a new ID. A late selection can already have left a draft under the
	 * new ID; the merged drafts keep the limit.
	 */
	moveTab(from: number, to: number): Promise<void> {
		return this.#update((drafts) =>
			newest(
				drafts.map((draft) => (draft.tabId === from ? { ...draft, tabId: to } : draft)),
				to,
				MAX_DRAFTS,
			),
		);
	}

	/** Saves nothing when `change` changes nothing: a tab pi never opened in costs one read. */
	#update(change: (drafts: readonly Draft[]) => readonly Draft[]): Promise<void> {
		const result = this.#writes.then(async () => {
			await this.load();
			const next = change(this.#drafts);
			if (next.length === this.#drafts.length && next.every((draft, index) => draft === this.#drafts[index])) return;
			await chrome.storage.session.set({ [DRAFTS_KEY]: next });
			this.#drafts = next;
			this.#changed();
		});
		this.#writes = result.catch(() => {});
		return result;
	}
}
