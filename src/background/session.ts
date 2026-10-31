import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { effectiveAnswerLanguage } from "../shared/language.ts";
import { isProvider, type Settings } from "../shared/protocol.ts";
import { userScriptsAllowed } from "../shared/user-scripts.ts";
import { ActiveWork } from "./active-work.ts";
import { Asks } from "./asks.ts";
import { checkRestarts, MAX_AUTOMATIC_RECOVERIES, MAX_BACKGROUND_RECOVERIES } from "./breaker.ts";
import { Chats, QUEUE_SETTINGS, serial } from "./chats.ts";
import { stopMarkers, unmarkStopping } from "./credentials.ts";
import { checkModel, imageLimit, models, syncPlanWindows, thinkingFor } from "./models.ts";
import { chromePageAccess, type PageDeps, pageMove } from "./page.ts";
import { offeredModes, pageExtension } from "./page-tools.ts";
import { CaptureQueue } from "./screenshot.ts";
import { currentSettings, loadSettings, saveSettings } from "./settings.ts";
import { StorageFull } from "./storage-full.ts";
import { chromeTabGroups } from "./tab-groups.ts";
import { Tabs } from "./tabs.ts";

const context = BACKGROUND_CONTEXT;
const DATABASE_NAME = "pi-aside-indexeddb";
const LOG_LIMIT = 200;
/** Set in `chrome.storage.session`, which the browser empties on restart and on extension reload or update. */
const BROWSER_SESSION_KEY = "browserSession";

/** Survives worker restarts, so the diagnostics log shows what happened across them. */
const DiagnosticsDoc = defineDoc<{ boots: number; log: string[] }>({
	kind: "piaside.diagnostics",
	version: 1,
	scope: "session",
	initial: () => ({ boots: 0, log: [] }),
	// A full copy every 50 changes bounds what an open replays.
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

const registry = createRegistry();
// Rendered before each request, so a change applies to the next answer in every chat.
registry.install(
	defineExtension({
		name: "piaside.language",
		sections: [
			section(
				"language",
				async () =>
					`Reply in ${effectiveAnswerLanguage((await loadSettings()).language)} unless the user asks for another language.`,
			),
		],
	}),
);

export type Opened = { harness: Harness; chats: Chats; boot: number; openMs: number };

type Listener = () => void;
const listeners = new Set<Listener>();
export function onChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
const changed = () => {
	for (const listener of listeners) listener();
};

let opening: Promise<Opened> | undefined;
/** Delete all chats, while it runs: an open waits for it, so none reaches the database while it goes (design 6.31). */
let erasing: Promise<void> | undefined;
let opened: Opened | undefined;
/** Counts opens, so that a Harness that closes late cannot reset the state of a newer one. */
let epoch = 0;
let log: string[] = [];
let browserSessionId: string | undefined;

export const activeWork = new ActiveWork(changed);
/** Chrome refused a write because the extension's storage is full (design 8). */
export const storageFull = new StorageFull(chrome.storage.session, changed);
/** The Ask cards of act_on_page, and the Allows of running answers. */
/** "For this chat" allowances: `chrome.storage.session` outlives the worker and empties when Chrome closes. */
const CHAT_GRANTS_KEY = "chatGrants";
export const asks = new Asks(changed, {
	async get() {
		const stored = (await chrome.storage.session.get(CHAT_GRANTS_KEY))[CHAT_GRANTS_KEY];
		return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
	},
	set: (keys) => chrome.storage.session.set({ [CHAT_GRANTS_KEY]: keys }),
});

/** The Harness the page tools read the transcript from, set as soon as it is open. */
let pageHarness: Harness | undefined;
const pageDeps: PageDeps = {
	access: chromePageAccess,
	settings: loadSettings,
	currentSettings,
	groups: chromeTabGroups,
	browserSession() {
		if (browserSessionId === undefined) throw new Error("The browser session is not ready");
		return browserSessionId;
	},
	binding: (tabId) => tabs.get(tabId),
	asks,
	async entries(conversationId, cursor, context) {
		const conversation = await pageHarness?.conversation(conversationId, context);
		if (conversation === undefined) throw new Error("The chat is not open");
		return conversation.entries({ order: "descending" }, 50, cursor, context);
	},
	async context(conversationId, context) {
		const conversation = await pageHarness?.conversation(conversationId, context);
		if (conversation === undefined) throw new Error("The chat is not open");
		return (await conversation.context(context)).messages;
	},
	captures: new CaptureQueue(),
};

/** The modes and call limit the page tools were installed with last. */
let installed = "";
// Arming an alarm awaits Chrome. Keep concurrent panels' registry installs in save order.
const installTools = serial();
/**
 * Offers the page tools that are not Off in `settings`, from every chat's next request (design 6.23), and run_script
 * only while Chrome's Allow User Scripts switch is on: Chrome has no event for it, so a send checks it again. The tools
 * check the settings as they are at each call themselves; this keeps what the model is told in step. False when the
 * tools installed already match.
 */
export function installPageTools(settings: Settings): Promise<boolean> {
	return installTools(async () => {
		const offered = { ...settings, tools: offeredModes(settings.tools, userScriptsAllowed()) };
		const key = JSON.stringify([offered.tools, offered.callsPerAnswer]);
		if (key === installed) return false;
		await activeWork.admit(async () => registry.install(pageExtension(pageDeps, offered)));
		installed = key;
		return true;
	});
}
/** The tabs' chats and newest gestures, kept in `storage.session`. */
export const tabs = new Tabs(chrome.storage.session, changed);
/**
 * The one command queue (design 6.17): chat commands, and the moves and drops of tabs. It does not need the Harness, so
 * closing a tab pi never opened in only reads `storage.session`.
 */
export const commands = serial();

/** The worker's single Harness, opened once per worker lifetime; every event handler awaits the same promise. */
export function session(): Promise<Opened> {
	if (opening === undefined) {
		const current = ++epoch;
		// Publishing the open Harness must not return from the lock callback: that would release ownership.
		const before = erasing ?? Promise.resolve();
		opening = before
			.then(
				() =>
					new Promise<Opened>((resolve, reject) => {
						void navigator.locks
							.request(DATABASE_NAME, async () => {
								try {
									const value = await open(current);
									resolve(value);
									await value.harness.closed;
								} catch (error) {
									reject(error);
								}
							})
							.catch(reject);
					}),
			)
			.catch((error: unknown) => {
				if (epoch === current) opening = undefined;
				throw error;
			});
	}
	return opening;
}

/** The open Harness, without opening one. */
export function currentSession(): Opened | undefined {
	return opened;
}

async function open(current: number): Promise<Opened> {
	const started = performance.now();
	const storage = await IndexedDbStorage.open(DATABASE_NAME);
	let harness: Harness;
	try {
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: QUEUE_SETTINGS,
				onWake: (wake) => activeWork.wake(wake),
				onReport: (error) => {
					console.error("[pi-durable]", error);
					void storageFull.note(error);
				},
			},
			context,
		);
	} catch (error) {
		await storage.close(context).catch(() => {});
		activeWork.detach();
		throw error;
	}
	pageHarness = harness;
	let chats: Chats | undefined;
	void harness.closed.then(() => {
		chats?.dispose();
		if (epoch !== current) return;
		opening = undefined;
		opened = undefined;
		activeWork.detach();
		changed();
	});
	try {
		const openMs = Math.round(performance.now() - started);
		await activeWork.attach(harness);
		const boot = await harness.commit(async (tx) => {
			const doc = await tx.doc(DiagnosticsDoc);
			doc.boots += 1;
			return doc.boots;
		}, context);
		log = [...((await harness.snapshot(DiagnosticsDoc, context))?.log ?? [])];

		const unfinished = await harness.inspect(context);
		const kinds = unfinished.tasks.map((task) => `${task.record.kind}(${task.state.kind})`);
		await appendLog(
			harness,
			`boot ${boot}: storage open in ${openMs} ms; ${kinds.length} unfinished task(s)${kinds.length > 0 ? `: ${kinds.join(", ")}` : ""}`,
		);
		const savedSession = (await chrome.storage.session.get(BROWSER_SESSION_KEY))[BROWSER_SESSION_KEY];
		const newBrowserSession = savedSession === undefined;
		// Upgrade the old boolean marker without treating an existing browser session as a restart.
		const sessionId = typeof savedSession === "string" && savedSession !== "" ? savedSession : crypto.randomUUID();
		const markers = await stopMarkers();
		const stopping = Object.keys(markers);
		// The breaker can commit aborts even while scheduling is paused. Arm before those commits too.
		for (const decision of await activeWork.admit(() =>
			checkRestarts(harness, context, { newBrowserSession, stopping }),
		)) {
			const limit = decision.kind === "run" ? MAX_AUTOMATIC_RECOVERIES : MAX_BACKGROUND_RECOVERIES;
			const verdict =
				decision.blocked === undefined
					? `recovery ${decision.recoveries}/${limit}`
					: `aborted (${decision.blocked}; Interrupted - Retry)`;
			await appendLog(harness, `restart breaker: ${decision.kind} ${decision.key}: ${verdict}`);
		}
		await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: sessionId });
		browserSessionId = sessionId;
		// The aborts above are committed: the removals cut short by a worker stop are finished. A removal that marked its
		// provider again meanwhile keeps its marker.
		for (const [provider, token] of Object.entries(markers)) await unmarkStopping(provider, token);
		const blocked = unfinished.tasks.filter((task) => task.state.kind === "blocked");
		for (const task of blocked) await appendLog(harness, `task ${task.record.id} ${task.record.kind} is blocked`);
		// Alarm recovery may have no panel to load these. Close policy must see persisted bindings before any tool runs.
		await tabs.load();
		chats = await Chats.open(harness, {
			serial: commands,
			tabs,
			tabOpen: (tabId) =>
				chrome.tabs.get(tabId).then(
					() => true,
					() => false,
				),
			openTabs: async () => new Set((await chrome.tabs.query({})).flatMap((tab) => tab.id ?? [])),
			admit: (operation) => activeWork.admit(operation),
			check: checkModel,
			imageLimit: async (model) => imageLimit(model),
			defaultModel: async () => (await loadSettings()).model,
			setDefaultModel: async ({ provider, modelId }) => {
				if (!isProvider(provider)) throw new Error(`Unknown provider ${provider}`);
				await saveSettings({ model: { provider, modelId } });
			},
			thinking: async (model) => thinkingFor(model, (await loadSettings()).thinking),
			moved: (page) => pageMove(page),
			changed,
		});
		await installPageTools(await loadSettings());
		// A ChatGPT plan's context windows, before a resumed answer compacts by them.
		await syncPlanWindows().catch(() => {});
		// Read Wake again after the breaker and registry changes; only now may a local deadline resume work.
		await activeWork.start();
		harness.resume();
		opened = { harness, chats, boot, openMs };
		changed();
		return opened;
	} catch (error) {
		// Close what this open acquired, so the next event does not open a second Harness on the same database.
		await harness.close(context).catch(() => {});
		throw error;
	}
}

/**
 * Erases every chat (design 6.31): closes the Harness, which stops the work it runs, clears what `storage.session`
 * keeps by chat ID (the tabs' chats, the script allowances), then deletes pi-durable's database under its Web Lock. A
 * fresh database numbers chats from 1 again, so an entry left over would reach another chat: they go first, and if
 * clearing them fails, nothing is deleted. Settings, keys, the sign-in, allowed sites, and shortcuts live in
 * `storage.local` or Chrome, and stay. Runs on the command queue, so no chat command runs meanwhile; opens wait for it.
 */
export function deleteAllChats(): Promise<void> {
	return commands(async () => {
		const erase = (async () => {
			const was = await (opening ?? Promise.resolve(undefined)).catch(() => undefined);
			if (was !== undefined) {
				await was.harness.close(context);
				await was.harness.closed;
			}
			pageHarness = undefined;
			await tabs.update((entries) => entries.clear());
			await asks.clear();
			await navigator.locks.request(DATABASE_NAME, () => IndexedDbStorage.delete(DATABASE_NAME));
			log = [];
		})();
		erasing = erase;
		try {
			await erase;
		} finally {
			if (erasing === erase) erasing = undefined;
		}
		const fresh = await session();
		await appendLog(fresh.harness, "all chats deleted");
		changed();
	});
}

/** Opens the Harness for an event that may be the reason the worker started, and logs that reason if it was. */
export async function wake(reason: string): Promise<Opened> {
	const fresh = opening === undefined;
	const opened = await session();
	if (fresh) await appendLog(opened.harness, `opened for ${reason}`);
	return opened;
}

export function currentLog(): readonly string[] {
	return log;
}

export async function appendLog(harness: Harness | undefined, line: string): Promise<void> {
	const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
	log = [...log, stamped].slice(-LOG_LIMIT);
	changed();
	if (harness === undefined) return;
	await harness.commit(async (tx) => {
		const doc = await tx.doc(DiagnosticsDoc);
		doc.log.push(stamped);
		if (doc.log.length > LOG_LIMIT) doc.log.splice(0, doc.log.length - LOG_LIMIT);
	}, context);
}

export async function clearLog(): Promise<void> {
	const { harness } = await session();
	await harness.commit(async (tx) => {
		(await tx.doc(DiagnosticsDoc)).log.splice(0);
	}, context);
	log = [];
	changed();
}
