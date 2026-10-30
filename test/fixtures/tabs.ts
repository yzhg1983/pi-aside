// The browser around `Chats` in tests: its open tabs, its `storage.session`, and what one tab's panel sends.

import type { Harness, ModelRef } from "@earendil-works/pi-durable";
import { Chats, type ChatsOptions, type Input, serial } from "../../src/background/chats.ts";
import { EMPTY_CHAT } from "../../src/background/projection.ts";
import { type SessionStore, Tabs } from "../../src/background/tabs.ts";
import type { ChatView } from "../../src/shared/protocol.ts";

/**
 * `storage.session` in memory. It outlives a worker, as Chrome's does; `failSet()` fails the next save, and
 * `holdSet()` holds it until the returned function is called.
 */
export function memoryStore() {
	const saved: Record<string, unknown> = {};
	let failures = 0;
	let held: Promise<void> | undefined;
	// `remove` for the worker's other uses of `storage.session`, such as a ChatGPT sign-in's.
	const store: SessionStore & { remove(key: string): Promise<void> } = {
		get: async (key) => (key in saved ? { [key]: structuredClone(saved[key]) } : {}),
		remove: async (key) => {
			delete saved[key];
		},
		set: async (items) => {
			const gate = held;
			held = undefined;
			await gate;
			if (failures > 0) {
				failures -= 1;
				throw new Error("storage failed");
			}
			Object.assign(saved, structuredClone(items));
		},
	};
	return {
		store,
		failSet() {
			failures += 1;
		},
		holdSet(): () => void {
			const gate = Promise.withResolvers<void>();
			held = gate.promise;
			return gate.resolve;
		},
	};
}

export type Browser = { store: SessionStore; open: Set<number> };

/** Opens `Chats` as the worker does, on `browser`'s tabs and one command queue. */
export async function openChats(
	harness: Harness,
	browser: Browser,
	options: Omit<ChatsOptions, "serial" | "tabs" | "tabOpen" | "openTabs">,
): Promise<{ chats: Chats; tabs: Tabs }> {
	const tabs = new Tabs(browser.store, options.changed);
	const chats = await Chats.open(harness, {
		...options,
		serial: serial(),
		tabs,
		tabOpen: async (tabId) => browser.open.has(tabId),
		openTabs: async () => new Set(browser.open),
	});
	return { chats, tabs };
}

/** What the panel of tab `tabId` sends: the tab's `rev` and the chat it shows, read at each call. */
export function panel(chats: Chats, tabs: Tabs, tabId: number) {
	const id = () => tabs.get(tabId)?.chat ?? null;
	const rev = () => tabs.get(tabId)?.rev ?? 0;
	return {
		/** The tab's chat; null while fresh or unresolved. */
		get id(): number | null {
			return id();
		},
		get rev(): number {
			return rev();
		},
		/** The tab's chat as the panel shows it, once its view is attached. */
		get chat(): ChatView {
			const shown = id();
			return (shown === null ? undefined : chats.view(shown)) ?? EMPTY_CHAT;
		},
		send: (input: Input, key: string | null = null) => chats.send(tabId, rev(), id(), input, key),
		retry: (entryId: number, requestId: string) => chats.retry(tabId, rev(), id() ?? -1, entryId, requestId),
		edit: (entryId: number, text: string, requestId: string, keep: readonly number[] = []) =>
			chats.edit(tabId, rev(), id() ?? -1, entryId, text, keep, requestId),
		abort: () => chats.abort(tabId, rev()),
		newChat: () => chats.newChat(tabId, rev()),
		openChat: (target: number) => chats.openChat(tabId, rev(), target),
		setModel: (model: ModelRef) => chats.setModel(tabId, rev(), model),
		list: () => chats.list(tabId),
		image: (entryId: number, index = 0) => chats.image(tabId, entryId, index),
	};
}

export type Panel = ReturnType<typeof panel>;
