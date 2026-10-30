import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vitest";
import { ACT_ON_PAGE, chromePageAccess, scopedPageAccess } from "../src/background/page.ts";
import { ALL_ON, pageDeps } from "./fixtures/page-deps.ts";

function browser() {
	const state = {
		attachedWindow: 3,
		front: [{ id: 12, windowId: 3, active: true }],
	};
	const get = vi.fn(async () => ({ id: 1, windowId: state.attachedWindow }));
	const query = vi.fn(async () => state.front);
	const update = vi.fn(async () => ({}));
	vi.stubGlobal("chrome", { tabs: { get, query, update } });
	return { state, get, query, update };
}

afterEach(() => vi.unstubAllGlobals());

it("returns to the attached tab only from an accepted opening in its original window", async () => {
	const { get, query, update } = browser();
	expect(await chromePageAccess.switchBack(1, [11, 12], 3)).toBe(12);
	expect(get).toHaveBeenCalledWith(1);
	expect(query).toHaveBeenCalledWith({ active: true, windowId: 3 });
	expect(update).toHaveBeenCalledExactlyOnceWith(1, { active: true });
});

it.each([
	{ name: "the original window has no active result", front: [], attachedWindow: 3 },
	{ name: "a different tab is active", front: [{ id: 20, windowId: 3, active: true }], attachedWindow: 3 },
	{ name: "the attached tab is already active", front: [{ id: 1, windowId: 3, active: true }], attachedWindow: 3 },
	{ name: "the opening is in a new window", front: [{ id: 12, windowId: 8, active: true }], attachedWindow: 3 },
	{
		name: "the attached tab moved to another window",
		front: [{ id: 12, windowId: 3, active: true }],
		attachedWindow: 8,
	},
])("does not activate when $name", async ({ front, attachedWindow }) => {
	const { state, update } = browser();
	state.front = front;
	state.attachedWindow = attachedWindow;
	expect(await chromePageAccess.switchBack(1, [11, 12], 3)).toBeNull();
	expect(update).not.toHaveBeenCalled();
});

it("does not activate if the attached tab disappeared or the foreground lookup failed", async () => {
	const { get, query, update } = browser();
	get.mockRejectedValueOnce(new Error("No tab with id: 1"));
	await expect(chromePageAccess.switchBack(1, [12], 3)).rejects.toThrow("No tab");
	expect(query).not.toHaveBeenCalled();
	query.mockRejectedValueOnce(new Error("lookup failed"));
	await expect(chromePageAccess.switchBack(1, [12], 3)).rejects.toThrow("lookup failed");
	expect(update).not.toHaveBeenCalled();
});

it.each(["off", "stop", "timeout"] as const)(
	"rechecks %s after the last asynchronous lookup, before activation",
	async (reason) => {
		const { query, update } = browser();
		const config = { current: ALL_ON };
		const { deps } = pageDeps(chromePageAccess, config);
		deps.groups.scope = async () => [{ id: 1, windowId: 3, groupId: -1 }];
		const controller = new AbortController();
		const context = { ...BACKGROUND_CONTEXT, abortSignal: controller.signal };
		const scoped = scopedPageAccess(deps, 1, 1, ACT_ON_PAGE, context);
		query.mockImplementationOnce(async () => {
			if (reason === "off") config.current = { ...ALL_ON, tools: { ...ALL_ON.tools, act: "off" } };
			if (reason === "stop") controller.abort();
			if (reason === "timeout") await new Promise((resolve) => setTimeout(resolve, 40));
			return [{ id: 12, windowId: 3, active: true }];
		});
		await expect(
			scoped.wait(() => scoped.access.switchBack(1, [12], 3), context, reason === "timeout" ? 10 : 1000),
		).rejects.toThrow();
		// A timed-out native query may still complete; it must not activate afterwards.
		if (reason === "timeout") await new Promise((resolve) => setTimeout(resolve, 60));
		expect(update).not.toHaveBeenCalled();
	},
);

it("rechecks scope before switch-back metadata requests", async () => {
	const { get, query, update } = browser();
	const { deps } = pageDeps(chromePageAccess, { current: ALL_ON });
	deps.groups.scope = async () => [];
	const scoped = scopedPageAccess(deps, 1, 1, ACT_ON_PAGE, BACKGROUND_CONTEXT);
	await expect(scoped.wait(() => scoped.access.switchBack(1, [12], 3), BACKGROUND_CONTEXT, 1000)).rejects.toThrow();
	expect(get).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
	expect(update).not.toHaveBeenCalled();
});
