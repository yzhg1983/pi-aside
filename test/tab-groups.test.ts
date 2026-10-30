import { afterEach, expect, it, vi } from "vitest";
import { chromeTabGroups, SCOPE_DENIED } from "../src/background/tab-groups.ts";

afterEach(() => vi.unstubAllGlobals());

function setup() {
	const tabs = new Map<number, chrome.tabs.Tab>();
	const put = (id: number, groupId = -1, windowId = 1) =>
		tabs.set(id, {
			id,
			groupId,
			windowId,
			index: id,
			active: false,
			pinned: false,
			highlighted: false,
			incognito: false,
			selected: false,
			discarded: false,
			autoDiscardable: true,
			frozen: false,
			lastAccessed: 0,
		});
	put(1);
	put(10);
	const group = vi.fn(async (options: chrome.tabs.GroupOptions) => {
		const ids = typeof options.tabIds === "number" ? [options.tabIds] : options.tabIds;
		for (const id of ids ?? []) tabs.get(id)!.groupId = options.groupId ?? 5;
		return options.groupId ?? 5;
	});
	const update = vi.fn(async () => ({}));
	vi.stubGlobal("chrome", {
		tabs: {
			get: vi.fn(async (id: number) => {
				const tab = tabs.get(id);
				if (!tab) throw Error("gone");
				return { ...tab };
			}),
			query: vi.fn(async ({ groupId, windowId }: chrome.tabs.QueryInfo) =>
				[...tabs.values()]
					.filter(
						(t) =>
							(groupId === undefined || t.groupId === groupId) &&
							(windowId === undefined || t.windowId === windowId),
					)
					.map((t) => ({ ...t })),
			),
			group,
		},
		tabGroups: { update },
	});
	return { tabs, put, group, update };
}

it("uses the current anchor group, including manually added members; ungrouped means anchor only", async () => {
	const { tabs, put } = setup();
	expect((await chromeTabGroups.scope(1)).map((t) => t.id)).toEqual([1]);
	put(1, 8);
	put(10, 8);
	put(20, 9);
	expect((await chromeTabGroups.scope(1)).map((t) => t.id)).toEqual([1, 10]);
	tabs.delete(1);
	await expect(chromeTabGroups.scope(1)).rejects.toThrow(SCOPE_DENIED);
});

it("groups accepted same-window ungrouped results without moving grouped or cross-window tabs", async () => {
	const { put, group, update, tabs } = setup();
	put(11, 9);
	put(12, -1, 2);
	const limitation = await chromeTabGroups.group(1, 1, [10, 11, 12], () => {});
	expect(group).toHaveBeenCalledWith({ tabIds: [1, 10], createProperties: { windowId: 1 } });
	expect(update).toHaveBeenCalledWith(5, { title: "pi" });
	expect(tabs.get(11)!.groupId).toBe(9);
	expect(limitation).toMatch(/outside/);
});

it("uses an existing group and never fails a completed action when grouping fails", async () => {
	const { put, group, update } = setup();
	put(1, 7);
	put(11, 7);
	await chromeTabGroups.group(1, 1, [10, 11], () => {});
	expect(group).toHaveBeenCalledExactlyOnceWith({ tabIds: [10], groupId: 7 });
	expect(update).not.toHaveBeenCalled();
	group.mockRejectedValueOnce(Error("cannot group"));
	put(12);
	expect(await chromeTabGroups.group(1, 1, [12], () => {})).toMatch(/could not group/);
});

it("does not unpin an anchor or result to group it", async () => {
	const { tabs, group } = setup();
	tabs.get(1)!.pinned = true;
	expect(await chromeTabGroups.group(1, 1, [10], () => {})).toMatch(/pinned/);
	expect(group).not.toHaveBeenCalled();
	tabs.get(1)!.pinned = false;
	tabs.get(10)!.pinned = true;
	expect(await chromeTabGroups.group(1, 1, [10], () => {})).toMatch(/pinned/);
	expect(group).not.toHaveBeenCalled();
	expect(tabs.get(10)!.pinned).toBe(true);
});

it("skips grouping if anchor or source membership changes during preparation", async () => {
	const { put, group } = setup();
	put(1, 7);
	put(2, 7);
	const get = vi.mocked(chrome.tabs.get);
	const chromeGet = get.getMockImplementation()! as (id: number) => Promise<chrome.tabs.Tab>;
	get.mockImplementation(async (id) => {
		const result = await chromeGet(id);
		if (id === 2) put(2, 9);
		return result;
	});
	expect(await chromeTabGroups.group(1, 2, [10], () => {})).toMatch(/changed/);
	expect(group).not.toHaveBeenCalled();
});

it("a candidate entering a user group during final source preparation is not stolen", async () => {
	const { put, group, tabs } = setup();
	put(1, 7);
	put(2, 7);
	const get = vi.mocked(chrome.tabs.get);
	const chromeGet = get.getMockImplementation()! as (id: number) => Promise<chrome.tabs.Tab>;
	const gate = Promise.withResolvers<void>();
	let waiting = false;
	get.mockImplementation(async (id) => {
		const tab = await chromeGet(id);
		if (id === 2) {
			waiting = true;
			await gate.promise;
		}
		return tab;
	});
	const running = chromeTabGroups.group(1, 2, [10], () => {});
	await vi.waitFor(() => expect(waiting).toBe(true));
	put(10, 9);
	gate.resolve();
	expect(await running).toMatch(/outside/);
	expect(group).not.toHaveBeenCalled();
	expect(tabs.get(10)!.groupId).toBe(9);
	expect(chrome.tabs.query).toHaveBeenLastCalledWith({ windowId: 1 });
	expect(get).toHaveBeenCalledTimes(2);
});

it("the final shared window snapshot has no later preparatory awaits before grouping", async () => {
	const { put, group, tabs } = setup();
	put(1, 7);
	put(2, 7);
	const calls: string[] = [];
	const get = vi.mocked(chrome.tabs.get);
	const nativeGet = get.getMockImplementation()! as (id: number) => Promise<chrome.tabs.Tab>;
	get.mockImplementation(async (id) => {
		calls.push(`get ${id}`);
		const result = await nativeGet(id);
		if (id === 2) put(10, 9);
		return result;
	});
	// Simulate another final preparation seeing the candidate's user-changed group.
	const query = vi.mocked(chrome.tabs.query);
	query.mockImplementation(async () => {
		calls.push("window snapshot");
		return [...tabs.values()].map((tab) => ({ ...tab }));
	});
	await chromeTabGroups.group(1, 2, [10], () => {
		calls.push("check");
	});
	expect(calls).toEqual(["check", "get 1", "check", "get 2", "check", "window snapshot"]);
	expect(group).not.toHaveBeenCalled();
});

it("timeout/abort during a metadata wait sends no later metadata or group request", async () => {
	const { group } = setup();
	const gate = Promise.withResolvers<void>();
	const get = vi.mocked(chrome.tabs.get);
	const nativeGet = get.getMockImplementation()! as (id: number) => Promise<chrome.tabs.Tab>;
	get.mockImplementation(async (id) => {
		const result = await nativeGet(id);
		await gate.promise;
		return result;
	});
	let ended = false;
	const running = chromeTabGroups.group(1, 1, [10], () => {
		if (ended) throw Error("aborted");
	});
	ended = true;
	gate.resolve();
	expect(await running).toMatch(/could not group/);
	expect(get).toHaveBeenCalledTimes(1);
	expect(chrome.tabs.query).not.toHaveBeenCalled();
	expect(group).not.toHaveBeenCalled();
});

it("failed native membership queries fail closed and unknown native metadata stays absent", async () => {
	const { put } = setup();
	expect(await chromeTabGroups.scope(1)).toEqual([{ id: 1, groupId: -1, windowId: 1 }]);
	put(1, 7);
	vi.mocked(chrome.tabs.query).mockRejectedValueOnce(Error("native failure"));
	await expect(chromeTabGroups.scope(1)).rejects.toThrow(SCOPE_DENIED);
});
