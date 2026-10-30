import { SessionFailed } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { isStorageFull, StorageFull } from "../src/background/storage-full.ts";
import { memoryStore } from "./fixtures/tabs.ts";

const quota = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

it("a quota error is a full disk, also as the cause of pi-durable's SessionFailed; other errors are not", () => {
	expect(isStorageFull(quota())).toBe(true);
	expect(isStorageFull(new SessionFailed(quota()))).toBe(true);
	expect(isStorageFull(new Error("outer", { cause: new SessionFailed(quota()) }))).toBe(true);
	expect(isStorageFull(new SessionFailed(new Error("IndexedDB transaction was aborted")))).toBe(false);
	expect(isStorageFull(new DOMException("gone", "InvalidStateError"))).toBe(false);
	expect(isStorageFull("QuotaExceededError")).toBe(false);
	expect(isStorageFull(undefined)).toBe(false);
	// A cause that points back at itself ends the walk.
	const looped = new Error("loop") as Error & { cause?: unknown };
	looped.cause = looped;
	expect(isStorageFull(looped)).toBe(false);
});

it("a full disk is kept in storage.session until a later write clears it, and only a change is announced", async () => {
	const { store } = memoryStore();
	const changed = vi.fn();
	const full = new StorageFull(store, changed);
	await full.note(new Error("network"));
	expect(full.full).toBe(false);
	expect(changed).not.toHaveBeenCalled();

	await full.note(new SessionFailed(quota()));
	expect(full.full).toBe(true);
	expect((await store.get("storageFull")).storageFull).toBe(true);
	await full.note(quota());
	expect(changed).toHaveBeenCalledTimes(1);

	// The next worker reads it back.
	const next = new StorageFull(store, vi.fn());
	await next.load();
	expect(next.full).toBe(true);

	await full.clear();
	expect(full.full).toBe(false);
	expect((await store.get("storageFull")).storageFull).toBe(false);
	expect(changed).toHaveBeenCalledTimes(2);
});

it("a load that ends after a newer note or clear keeps that value", async () => {
	const { store } = memoryStore();
	await store.set({ storageFull: false });
	const read = Promise.withResolvers<Record<string, unknown>>();
	const full = new StorageFull({ get: () => read.promise, set: store.set.bind(store) }, vi.fn());
	const loading = full.load();
	await full.note(quota());
	read.resolve({ storageFull: false });
	await loading;
	expect(full.full).toBe(true);
});

it("a clear for a write that went through keeps a full disk noted since the write began", async () => {
	const { store } = memoryStore();
	const full = new StorageFull(store, vi.fn());
	await full.note(quota());
	// A send begins with the banner shown, and is saved: the disk has room again.
	const send = full.mark();
	await full.clear(send);
	expect(full.full).toBe(false);
	// Another send begins; a background write fails before it ends.
	const next = full.mark();
	await full.note(quota());
	await full.clear(next);
	expect(full.full).toBe(true);
	// Delete all chats clears it whatever was noted.
	await full.clear();
	expect(full.full).toBe(false);
});

it("a worker a gesture woke clears the stored value before it has read it", async () => {
	const { store } = memoryStore();
	await store.set({ storageFull: true });
	// A send saved before any panel connected, so before load().
	const full = new StorageFull(store, vi.fn());
	await full.clear(full.mark());
	expect((await store.get("storageFull")).storageFull).toBe(false);
	await full.load();
	expect(full.full).toBe(false);
});
