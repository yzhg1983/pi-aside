import { expect, it } from "vitest";
import { type SessionStore, type TabEntry, Tabs, UNRESOLVED } from "../src/background/tabs.ts";

const entry = (chat: number | null, rev = 0): TabEntry => ({ ...UNRESOLVED, chat, rev });

/** `storage.session` with entries for tabs 1 and 2; `get` waits until `release()`. */
function store() {
	let saved: Record<string, unknown> = { tabs: { 1: entry(10), 2: entry(20) } };
	let release!: () => void;
	const loaded = new Promise<void>((resolve) => {
		release = resolve;
	});
	let getFailures = 0;
	let setFailures = 0;
	const area: SessionStore = {
		async get(key) {
			await loaded;
			if (getFailures > 0) {
				getFailures -= 1;
				throw new Error("storage failed");
			}
			return { [key]: structuredClone(saved[key]) };
		},
		async set(items) {
			if (setFailures > 0) {
				setFailures -= 1;
				throw new Error("storage full");
			}
			saved = { ...saved, ...structuredClone(items) };
		},
	};
	return {
		area,
		release,
		failGet() {
			getFailures += 1;
		},
		failSet() {
			setFailures += 1;
		},
		saved: () => saved.tabs as Record<string, TabEntry>,
	};
}

it("a change in a worker that just started keeps the other tabs' saved entries", async () => {
	const storage = store();
	const tabs = new Tabs(storage.area, () => {});
	const changed = tabs.set(1, (current) => ({ ...current, rev: 1 }));
	storage.release();
	await changed;
	expect(Object.keys(storage.saved())).toEqual(["1", "2"]);
	expect(storage.saved()["1"]).toEqual(entry(10, 1));
	expect(tabs.get(2)).toEqual(entry(20));
});

it("a tab dropped before the saved entries loaded does not come back", async () => {
	const storage = store();
	const tabs = new Tabs(storage.area, () => {});
	const dropped = tabs.update((entries) => entries.delete(2));
	const loaded = tabs.load();
	storage.release();
	await Promise.all([dropped, loaded]);
	expect(tabs.get(2)).toBeUndefined();
	expect(Object.keys(storage.saved())).toEqual(["1"]);
});

it("a failed load saves nothing and is tried again", async () => {
	const storage = store();
	const tabs = new Tabs(storage.area, () => {});
	storage.failGet();
	storage.release();
	await expect(tabs.update((entries) => entries.delete(2))).rejects.toThrow("storage failed");
	expect(Object.keys(storage.saved())).toEqual(["1", "2"]);
	await tabs.update((entries) => entries.delete(2));
	expect(Object.keys(storage.saved())).toEqual(["1"]);
});

it("a failed save changes nothing in memory; a tab without an entry starts unresolved", async () => {
	const storage = store();
	const tabs = new Tabs(storage.area, () => {});
	storage.release();
	await tabs.load();
	storage.failSet();
	await expect(tabs.set(3, () => entry(30))).rejects.toThrow("storage full");
	expect(tabs.get(3)).toBeUndefined();
	await tabs.set(1, (current) => ({ ...current, chat: null }));
	expect(storage.saved()).toEqual({ 1: entry(null), 2: entry(20) });

	await tabs.set(4, (current) => ({ ...current, url: "https://example.com/" }));
	expect(tabs.get(4)).toEqual({ ...UNRESOLVED, url: "https://example.com/" });
	expect("chat" in tabs.get(4)!).toBe(false);
});
