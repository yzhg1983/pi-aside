// The browser around the service worker in tests. Loading this module installs a `chrome` stub, so it must load before
// `main.ts` registers its listeners. An API the stub does not define answers with a resolved promise; an event keeps
// its listeners for `fire()`. `workerSession` stands in for `session.ts`: the same `Tabs` and command queue, with a
// Harness on Node SQLite and the faux provider.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Asks } from "../../src/background/asks.ts";
import { Chats, serial } from "../../src/background/chats.ts";
import type { Opened } from "../../src/background/session.ts";
import { StorageFull } from "../../src/background/storage-full.ts";
import { Tabs } from "../../src/background/tabs.ts";
import { PANEL_PORT, type PageMessage, type Settings, type WorkerMessage } from "../../src/shared/protocol.ts";
import { memoryStore } from "./tabs.ts";

type Listener = (...args: unknown[]) => unknown;
type Injection = { documentId: string; result: unknown };

const listeners = new Map<string, Listener[]>();
const session = memoryStore();
const local = new Map<string, unknown>();

/** What the tests control: the open tabs, `storage.session`, `storage.local`, and the page scripts. */
export const browser = {
	open: new Set<number>(),
	session,
	local,
	/** Answers `scripting.executeScript` in the frames of `frameIds`; the default reads nothing. */
	inject: async (_tabId: number, _frameIds?: number[], _args?: unknown[]): Promise<Injection[]> => [],
};

const overrides: Record<string, unknown> = {
	"runtime.id": "ext",
	"runtime.lastError": undefined,
	"runtime.getURL": (path: string) => `chrome-extension://ext/${path}`,
	"i18n.getUILanguage": () => "en",
	"storage.session": session.store,
	"storage.local.get": async (key: string) => (local.has(key) ? { [key]: structuredClone(local.get(key)) } : {}),
	"storage.local.set": async (items: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(items)) local.set(key, structuredClone(value));
	},
	"scripting.executeScript": ({
		target,
		args,
	}: {
		target: { tabId: number; frameIds?: number[] };
		args?: unknown[];
	}) => browser.inject(target.tabId, target.frameIds, args),
	"tabs.get": async (tabId: number) => {
		if (!browser.open.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
		return { id: tabId };
	},
	"tabs.query": async () => [...browser.open].map((id) => ({ id })),
	"permissions.contains": async () => true,
	// Chrome calls back once the menu has changed.
	"contextMenus.removeAll": (done: () => void) => done(),
	"contextMenus.create": (_item: unknown, done: () => void) => done(),
};

function api(path: string): unknown {
	return new Proxy(() => {}, {
		get(_, key) {
			// Not a promise: an awaited API object must not look like one.
			if (typeof key !== "string" || key === "then") return undefined;
			const name = path === "" ? key : `${path}.${key}`;
			if (name in overrides) return overrides[name];
			if (key === "addListener") {
				return (listener: Listener) => listeners.set(path, [...(listeners.get(path) ?? []), listener]);
			}
			return api(name);
		},
		apply: () => Promise.resolve(undefined),
	});
}
(globalThis as { chrome?: unknown }).chrome = api("");

/** Calls the listeners of event `name`, such as "tabs.onRemoved". */
export function fire(name: string, ...args: unknown[]): void {
	for (const listener of listeners.get(name) ?? []) listener(...args);
}

/** A panel of tab `tabId` connecting to the worker: what it was sent, what it sends, and its closing. */
export function connect(tabId: number) {
	const received: WorkerMessage[] = [];
	const onMessage: Listener[] = [];
	const onDisconnect: Listener[] = [];
	let connected = true;
	const port = {
		name: PANEL_PORT,
		sender: { id: "ext", url: `chrome-extension://ext/panel.html?tab=${tabId}` },
		onMessage: { addListener: (listener: Listener) => onMessage.push(listener) },
		onDisconnect: { addListener: (listener: Listener) => onDisconnect.push(listener) },
		postMessage: (message: WorkerMessage) => {
			// As Chrome's port does.
			if (!connected) throw new Error("Attempting to use a disconnected port object");
			received.push(message);
		},
		disconnect: () => {
			connected = false;
		},
	};
	fire("runtime.onConnect", port);
	return {
		received,
		send(message: PageMessage): void {
			for (const listener of onMessage) listener(message);
		},
		/** The panel closes. */
		disconnect(): void {
			connected = false;
			for (const listener of onDisconnect) listener(port);
		},
	};
}

const context = BACKGROUND_CONTEXT;
export const faux = fauxProvider({ provider: "openrouter", models: [{ id: "one" }] });
const models = createModels();
models.setProvider(faux.provider);

let opening: Promise<Opened> | undefined;
let opened: Opened | undefined;
const changes = new Set<() => void>();
const changed = () => {
	for (const listener of changes) listener();
};
const tabs = new Tabs(session.store, changed);
const storageFull = new StorageFull(session.store, changed);
const commands = serial();

async function open(): Promise<Opened> {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(mkdtempSync(join(tmpdir(), "pi-aside-worker-")), "session.sqlite")),
		{ models, registry: createRegistry() },
		context,
	);
	const chats = await Chats.open(harness, {
		serial: commands,
		tabs,
		tabOpen: async (tabId) => browser.open.has(tabId),
		openTabs: async () => new Set(browser.open),
		admit: (operation) => operation(),
		check: async () => {},
		imageLimit: async () => 20,
		defaultModel: async () => ({ provider: "openrouter", modelId: "one" }),
		setDefaultModel: async () => {},
		thinking: async () => "off",
		changed,
	});
	harness.resume();
	opened = { harness, chats, boot: 1, openMs: 0 };
	return opened;
}

/** The settings each install of the page tools was made with. */
export const installs: Settings[] = [];
/** As `session.ts`: the modes and call limit installed last. */
let installed = "";

/** The exports of `session.ts`. */
export const workerSession = {
	activeWork: {
		latest: { active: false, at: undefined as number | undefined },
		enabled: false,
		keepalive: false,
		setEnabled: async () => {},
		admit: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
	},
	asks: new Asks(changed),
	/** Delete all chats: counted; the session module's own test runs the real one. */
	deletedAll: 0,
	async deleteAllChats(): Promise<void> {
		workerSession.deletedAll += 1;
	},
	async installPageTools(settings: Settings): Promise<boolean> {
		const key = JSON.stringify([settings.tools, settings.callsPerAnswer]);
		if (key === installed) return false;
		installed = key;
		installs.push(settings);
		return true;
	},
	appendLog: async () => {},
	clearLog: async () => {},
	commands,
	currentLog: () => [],
	currentSession: () => opened,
	onChange(listener: () => void) {
		changes.add(listener);
		return () => changes.delete(listener);
	},
	session: () => {
		opening ??= open();
		return opening;
	},
	storageFull,
	tabs,
	wake: () => workerSession.session(),
};
