import { Harness, type Registry } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { expect, it, type Mock, vi } from "vitest";
import { ActiveWork } from "../src/background/active-work.ts";
import { Chats } from "../src/background/chats.ts";
import { currentSession, deleteAllChats, installPageTools, session, tabs } from "../src/background/session.ts";
import { loadSettings } from "../src/background/settings.ts";

const fixture = vi.hoisted(() => {
	const state = {
		hydration: Promise.withResolvers<Record<string, unknown>>(),
		lockLine: Promise.resolve<unknown>(undefined),
		held: false,
		browserSession: true as boolean | string | undefined,
	};
	const get = vi.fn(async (key: string) =>
		key === "tabs" ? state.hydration.promise : { browserSession: state.browserSession },
	);
	const request = vi.fn((_name: string, use: () => Promise<void>) => {
		const next = state.lockLine.then(async () => {
			state.held = true;
			try {
				await use();
			} finally {
				state.held = false;
			}
		});
		state.lockLine = next.catch(() => {});
		return next;
	});
	vi.stubGlobal("navigator", { locks: { request } });
	const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
	vi.stubGlobal("chrome", {
		alarms: {
			get: async (name: string) => alarms.get(name),
			create: async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
				alarms.set(name, info);
			},
			clear: async (name: string) => alarms.delete(name),
		},
		runtime: { getPlatformInfo: async () => ({}) },
		storage: {
			session: {
				get,
				set: vi.fn(async (value: { browserSession?: string }) => {
					if (value.browserSession !== undefined) state.browserSession = value.browserSession;
				}),
			},
			local: { get: vi.fn(async () => ({})) },
		},
		i18n: { getUILanguage: () => "en" },
	});
	return { state, get, request, alarms, storage: { close: vi.fn(async () => {}) } };
});
vi.mock("../src/background/models.ts", () => ({ models: {}, checkModel: vi.fn(), syncPlanWindows: async () => {} }));
vi.mock("../src/background/credentials.ts", () => ({ stopMarkers: async () => ({}), unmarkStopping: vi.fn() }));
vi.mock("../src/background/breaker.ts", () => ({
	checkRestarts: async () => [],
	MAX_AUTOMATIC_RECOVERIES: 1,
	MAX_BACKGROUND_RECOVERIES: 1,
}));

it("holds the storage lock through Harness closure, releases failed opens, and hydrates bindings before recovery", async () => {
	const resumeBindings: unknown[] = [];
	const makeHarness = () => {
		const end = Promise.withResolvers<void>();
		return {
			closed: end.promise,
			commit: vi.fn(async () => 1),
			snapshot: vi.fn(async () => ({ log: [] })),
			inspect: vi.fn(async () => ({ tasks: [] })),
			taskGraph: vi.fn(async () => ({})),
			wake: vi.fn(() => ({ active: false })),
			close: vi.fn(async () => {
				await fixture.storage.close();
				end.resolve();
			}),
			resume: vi.fn(() => {
				resumeBindings.push(tabs.get(10), tabs.get(11), tabs.get(12));
			}),
		};
	};
	let harness = makeHarness();
	const openHarness = vi.spyOn(Harness, "open").mockImplementation(async () => {
		expect(fixture.state.held).toBe(true);
		return harness as unknown as Harness;
	});
	const openStorage = vi.spyOn(IndexedDbStorage, "open").mockImplementation(async () => {
		expect(fixture.state.held).toBe(true);
		return fixture.storage as unknown as IndexedDbStorage;
	});
	vi.spyOn(Chats, "open").mockResolvedValue({ dispose: vi.fn() } as unknown as Chats);
	const start = vi.spyOn(ActiveWork.prototype, "start");
	try {
		fixture.request.mockRejectedValueOnce(Error("cannot acquire ownership"));
		await expect(session()).rejects.toThrow("cannot acquire ownership");
		expect(openStorage).not.toHaveBeenCalled();

		openStorage.mockRejectedValueOnce(Error("cannot open IndexedDB"));
		await expect(session()).rejects.toThrow("cannot open IndexedDB");
		await vi.waitFor(() => expect(fixture.state.held).toBe(false));
		expect(openHarness).not.toHaveBeenCalled();

		openHarness.mockRejectedValueOnce(Error("cannot open Harness"));
		await expect(session()).rejects.toThrow("cannot open Harness");
		await vi.waitFor(() => expect(fixture.state.held).toBe(false));
		expect(fixture.storage.close).toHaveBeenCalledTimes(1);

		// No panel entry point or fixture preload. Missing is not the same as not yet hydrated.
		expect(tabs.get(10)).toBeUndefined();
		const opening = session();
		const outcome = opening.catch((error: unknown) => error);
		expect(session()).toBe(opening);
		await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledWith("tabs"));
		expect(harness.resume).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(currentSession()).toBeUndefined();
		fixture.state.hydration.reject(Error("session storage unavailable"));
		expect(await outcome).toMatchObject({ message: "session storage unavailable" });
		expect(harness.close).toHaveBeenCalledTimes(1);
		expect(harness.resume).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(fixture.state.held).toBe(false));

		harness = makeHarness();
		fixture.state.hydration = Promise.withResolvers<Record<string, unknown>>();
		const retry = session();
		await vi.waitFor(() => expect(fixture.get.mock.calls.filter(([key]) => key === "tabs")).toHaveLength(2));
		expect(harness.resume).not.toHaveBeenCalled();
		const base = { rev: 0, resumed: null, url: null, anchor: null, page: null };
		const bound = { ...base, chat: 999 };
		const fresh = { ...base, chat: null };
		const unresolved = { ...base };
		fixture.state.hydration.resolve({ tabs: { 10: bound, 11: fresh, 12: unresolved } });
		await retry;
		expect(start).toHaveBeenCalledTimes(1);
		expect(harness.taskGraph).not.toHaveBeenCalled();
		expect(openHarness).toHaveBeenLastCalledWith(
			fixture.storage,
			expect.objectContaining({ onWake: expect.any(Function) }),
			expect.anything(),
		);
		expect(harness.resume).toHaveBeenCalledTimes(1);
		expect(resumeBindings).toEqual([bound, fresh, unresolved]);
		expect(openStorage).toHaveBeenLastCalledWith("pi-aside-indexeddb");
		expect(fixture.request).toHaveBeenLastCalledWith("pi-aside-indexeddb", expect.any(Function));
		expect(fixture.state.held).toBe(true);
		const sessionId = fixture.state.browserSession;
		expect(sessionId).toEqual(expect.any(String));
		expect(sessionId).not.toBe("");

		// Registry changes can unblock stored tasks. Every install must have fallback recovery first.
		const registry = openHarness.mock.calls.at(-1)![1].registry as Registry;
		const originalInstall = registry.install.bind(registry);
		const install = vi.spyOn(registry, "install").mockImplementation((extension) => {
			expect(fixture.alarms.get("recovery")?.periodInMinutes).toBe(1);
			originalInstall(extension);
		});
		const settings = await loadSettings();
		expect(
			await Promise.all([
				installPageTools({ ...settings, tools: { ...settings.tools, read: "off" } }),
				installPageTools(settings),
			]),
		).toEqual([true, true]);
		expect(install).toHaveBeenCalledTimes(2);
		expect(await installPageTools(settings)).toBe(false);

		expect(currentSession()?.harness).toBe(harness);

		await harness.close();
		await vi.waitFor(() => expect(fixture.state.held).toBe(false));
		expect(currentSession()).toBeUndefined();
		harness = makeHarness();
		await session();
		expect(fixture.state.held).toBe(true);
		expect(currentSession()?.harness).toBe(harness);
		expect(fixture.state.browserSession).toBe(sessionId);
		await harness.close();
		await vi.waitFor(() => expect(fixture.state.held).toBe(false));
		fixture.state.browserSession = undefined;
		harness = makeHarness();
		await session();
		expect(fixture.state.browserSession).toEqual(expect.any(String));
		expect(fixture.state.browserSession).not.toBe(sessionId);

		// Delete all chats (design 6.31): the Harness closes, the database goes under the lock, the tabs' chats and the
		// script allowances are cleared, and an open while it runs waits for it and gets the fresh database.
		await tabs.update((entries) => entries.set(10, { ...bound }));
		const old = harness;
		harness = makeHarness();
		const order: string[] = [];
		const set = chrome.storage.session.set as unknown as Mock<(value: Record<string, unknown>) => Promise<void>>;
		const drop = vi.spyOn(IndexedDbStorage, "delete").mockImplementation(async () => {
			const scriptsCleared = set.mock.calls.some(([value]) => JSON.stringify(value) === '{"chatScripts":[]}');
			order.push(`delete held=${fixture.state.held} tabs=${tabs.get(10) ?? "cleared"} scripts=${scriptsCleared}`);
		});
		openHarness.mockImplementation(async () => {
			order.push("open");
			return harness as unknown as Harness;
		});
		const erase = deleteAllChats();
		await vi.waitFor(() => expect(old.close).toHaveBeenCalled());
		const between = session();
		await erase;
		expect(drop).toHaveBeenCalledWith("pi-aside-indexeddb");
		// What storage.session keeps by chat ID is cleared before the database goes.
		expect(order).toEqual(["delete held=true tabs=cleared scripts=true", "open"]);
		expect((await between).harness).toBe(harness);
		expect(currentSession()?.harness).toBe(harness);
		expect(tabs.get(10)).toBeUndefined();

		// When clearing either fails, nothing is deleted: a fresh database would number chats from 1 again, and an
		// entry left over would reach another chat.
		drop.mockClear();
		const save = set.getMockImplementation()!;
		for (const failing of ["tabs", "chatScripts"]) {
			await tabs.update((entries) => entries.set(10, { ...bound }));
			set.mockImplementation(async (value) => {
				if (failing in value) throw Error(`${failing} not saved`);
				return save(value);
			});
			await expect(deleteAllChats()).rejects.toThrow(`${failing} not saved`);
			set.mockImplementation(save);
			expect(drop).not.toHaveBeenCalled();
			harness = makeHarness();
			expect((await session()).harness).toBe(harness);
		}
	} finally {
		await harness.close();
		await fixture.state.lockLine;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
