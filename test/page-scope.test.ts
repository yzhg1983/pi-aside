import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, expect, it, vi } from "vitest";
import {
	ACT_ON_PAGE,
	chromePageAccess,
	OBSERVE_PAGE,
	type PageAccess,
	READ_PAGE,
	RUN_SCRIPT,
	SCREENSHOT_PAGE,
	scopedPageAccess,
} from "../src/background/page.ts";
import { chromeTabGroups } from "../src/background/tab-groups.ts";
import { ALL_ON, NO_AGENT, pageDeps } from "./fixtures/page-deps.ts";

afterEach(() => vi.unstubAllGlobals());

function setup(tool = READ_PAGE, controller = new AbortController()) {
	const access: PageAccess = {
		...NO_AGENT,
		frames: async () => [],
		text: async () => null,
		current: async () => null,
		timeoutMs: 30,
	};
	const config = { current: structuredClone(ALL_ON) };
	const { deps } = pageDeps(access, config);
	const ids = new Set([41, 99]);
	deps.groups.scope = async (anchor) => {
		if (anchor !== 41 || !ids.has(41)) throw Error("native lookup failed");
		return [...ids].map((id) => ({ id, groupId: 3, windowId: 1 }));
	};
	const scoped = scopedPageAccess(deps, 41, 99, tool, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
	return { access, config, deps, ids, scoped, controller };
}

it("fails closed for an absent anchor or native lookup failure, regardless of a valid selected ID", async () => {
	const s = setup();
	const top = vi.spyOn(s.access, "top");
	s.ids.delete(41);
	await expect(s.scoped.access.top(99)).rejects.toThrow(/current group/);
	s.ids.add(41);
	s.deps.groups.scope = async () => {
		throw Error("Chrome failed");
	};
	await expect(s.scoped.access.current(99, "cached-document")).rejects.toThrow(/current group/);
	expect(top).not.toHaveBeenCalled();
});

it.each([
	"frames",
	"text",
	"current",
	"top",
	"observe",
	"act",
	"navigate",
	"scriptWorld",
	"script",
	"locate",
	"scroll",
	"tabState",
	"capture",
	"close",
] as const)("%s rechecks membership after a preparatory wait and sends nothing to a removed member", async (method) => {
	const s = setup();
	const native = vi.spyOn(s.access, method);
	const gate = Promise.withResolvers<void>();
	let waiting = false;
	s.deps.groups.scope = async () => {
		waiting = true;
		await gate.promise;
		return [...s.ids].map((id) => ({ id, groupId: 3, windowId: 1 }));
	};
	const a = s.scoped.access;
	const send = () => {
		switch (method) {
			case "frames":
				return a.frames(99);
			case "text":
				return a.text(99, "d", 10, 10);
			case "current":
				return a.current(99, "d");
			case "top":
				return a.top(99);
			case "observe":
				return a.observe(99, "d", {
					op: "observe",
					known: [],
					letter: "a",
					find: null,
					within: null,
					maxBytes: 100,
					budgetMs: 10,
					maxElements: 10,
					maxMatches: 10,
					maxUrl: 100,
				});
			case "act":
				return a.act(99, "d", {
					op: "act",
					action: "press",
					target: null,
					known: [],
					text: null,
					submit: false,
					key: "Enter",
					option: null,
					direction: null,
					summary: null,
					quietMs: 0,
					maxWaitMs: 1,
					outlineMs: 0,
					maxUrl: 100,
				});
			case "navigate":
				return a.navigate(99, "d", "reload");
			case "scriptWorld":
				return a.scriptWorld();
			case "script":
				return a.script(99, "d", "1", 100);
			case "locate":
				return a.locate(99, "d", { op: "locate", target: { letter: "a", mapId: "m", number: 1 } });
			case "scroll":
				return a.scroll(99, "d", { op: "scroll", target: null, direction: "down" });
			case "tabState":
				return a.tabState(99);
			case "capture":
				return a.capture(1);
			case "close":
				return a.close(99);
		}
	};
	const running = send();
	const rejected = expect(running).rejects.toThrow(/current group/);
	await vi.waitFor(() => expect(waiting).toBe(true));
	s.ids.delete(99);
	gate.resolve();
	await rejected;
	expect(native).not.toHaveBeenCalled();
});

it("forwards selection scope through the same native dispatch guard", async () => {
	const s = setup();
	const native = vi.spyOn(s.access, "text");
	await s.scoped.access.text(99, "d", 100, 10, "selection");
	expect(native).toHaveBeenCalledWith(99, "d", 100, 10, "selection");
});

it.each(["removed", "Off", "Stop", "timeout"] as const)(
	"selection sends no text read after %s during scope lookup",
	async (change) => {
		const s = setup();
		const native = vi.spyOn(s.access, "text");
		const gate = Promise.withResolvers<void>();
		s.deps.groups.scope = async () => {
			await gate.promise;
			return [...s.ids].map((id) => ({ id, groupId: 3, windowId: 1 }));
		};
		const running = s.scoped.access.text(99, "d", 100, 10, "selection");
		const rejected = expect(running).rejects.toThrow();
		if (change === "removed") s.ids.delete(99);
		else if (change === "Off") s.config.current = { ...ALL_ON, tools: { ...ALL_ON.tools, read: "off" } };
		else if (change === "Stop") s.controller.abort();
		if (change === "removed" || change === "Off") gate.resolve();
		await rejected;
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(native).not.toHaveBeenCalled();
	},
);

it.each([READ_PAGE, OBSERVE_PAGE, ACT_ON_PAGE, RUN_SCRIPT, SCREENSHOT_PAGE])(
	"%s checks Off synchronously after a delayed scope lookup",
	async (tool) => {
		const s = setup(tool);
		const native = vi.spyOn(s.access, "top");
		const gate = Promise.withResolvers<void>();
		s.deps.groups.scope = async () => {
			await gate.promise;
			return [{ id: 99, groupId: 3, windowId: 1 }];
		};
		const running = s.scoped.access.top(99);
		const rejected = expect(running).rejects.toThrow(/turned off/);
		s.config.current = {
			...ALL_ON,
			tools: { read: "off", observe: "off", act: "off", script: "off", screenshot: "off" },
		};
		gate.resolve();
		await rejected;
		expect(native).not.toHaveBeenCalled();
	},
);

it.each(["Stop", "timeout"])("a delayed scope lookup cannot send late work after %s", async (kind) => {
	const s = setup();
	const native = vi.spyOn(s.access, "navigate");
	const gate = Promise.withResolvers<void>();
	s.deps.groups.scope = async () => {
		await gate.promise;
		return [{ id: 99, groupId: 3, windowId: 1 }];
	};
	const running = s.scoped.wait(() => s.scoped.access.navigate(99, "d", "reload"), BACKGROUND_CONTEXT, 10);
	const rejected = expect(running).rejects.toThrow();
	if (kind === "Stop") s.controller.abort();
	await rejected;
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(native).not.toHaveBeenCalled();
});

it.each([
	["scope", "Stop"],
	["scope", "timeout"],
	["tabState", "Stop"],
	["tabState", "timeout"],
] as const)("native %s sends no follow-up metadata after %s during tabs.get", async (helper, end) => {
	const s = setup();
	const gate = Promise.withResolvers<void>();
	const get = vi.fn(async (id: number) => {
		await gate.promise;
		return { id, groupId: 3, windowId: 1, active: true };
	});
	const query = vi.fn(async () => [
		{ id: 41, groupId: 3, windowId: 1 },
		{ id: 99, groupId: 3, windowId: 1 },
	]);
	const windowGet = vi.fn(async () => ({ state: "normal" }));
	vi.stubGlobal("chrome", { tabs: { get, query }, windows: { get: windowGet } });
	const current = vi.spyOn(s.access, "current");
	if (helper === "scope") s.deps.groups = chromeTabGroups;
	else s.access.tabState = chromePageAccess.tabState;
	const outcome = (helper === "scope" ? s.scoped.access.current(99, "d") : s.scoped.access.tabState(99)).catch(
		(error: unknown) => error,
	);
	await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1), { interval: 1 });
	if (end === "Stop") s.controller.abort();
	expect(await outcome).toBeInstanceOf(Error);
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(query).not.toHaveBeenCalled();
	expect(windowGet).not.toHaveBeenCalled();
	expect(current).not.toHaveBeenCalled();
});

it.each(["removed", "Off"])("native load polling renews scope and policy before each poll: %s", async (change) => {
	const s = setup(ACT_ON_PAGE);
	s.access.timeoutMs = 500;
	s.access.loaded = chromePageAccess.loaded;
	const get = vi.fn(async () => ({ status: "loading" }));
	vi.stubGlobal("chrome", { tabs: { get } });
	const outcome = s.scoped.access.loaded(99, 1_000, s.controller.signal).catch((error: unknown) => error);
	await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1), { interval: 1 });
	if (change === "removed") s.ids.delete(99);
	else s.config.current = { ...ALL_ON, tools: { ...ALL_ON.tools, act: "off" } };
	expect(await outcome).toBeInstanceOf(Error);
	expect(get).toHaveBeenCalledTimes(1);
});
