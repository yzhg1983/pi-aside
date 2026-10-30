// Service worker entry. Every listener is registered synchronously at module scope, so the event that started the
// worker is delivered; handlers then await the one shared Harness.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Credential } from "@earendil-works/pi-ai";
import { attached, checkAttachments, withAttachments } from "../shared/attachments.ts";
import { t } from "../shared/i18n.ts";
import { effectiveAnswerLanguage } from "../shared/language.ts";
import { fillTemplate, PAGE_SELECTION, PRESETS, presetDisplayName, presetOn } from "../shared/presets.ts";
import {
	type Attachment,
	CHATGPT,
	type Command,
	type Draft,
	isProvider,
	MAX_URL_CHARS,
	type ModelInfo,
	type Notice,
	PANEL_PORT,
	type PageMessage,
	type PageRef,
	type PanelState,
	PROVIDERS,
	type ProviderId,
	pageTitle,
	RECOMMENDED_MODELS,
	type SelectionData,
	type SelectionEntryData,
	type Settings,
	type SettingsSaved,
	type Status,
	siteOrigin,
	subscriptionToken,
	type ToolModes,
} from "../shared/protocol.ts";
import { RECOVERY_ALARM } from "./active-work.ts";
import {
	CALLBACK_PAGE,
	cancelSignIn,
	EXPIRE_ALARM,
	finishSignIn,
	keepAccount,
	PLAN_ORIGINS,
	revoke,
	savedAccount,
	signInWaiting,
	startSignIn,
	tidySignIn,
} from "./chatgpt.ts";
import { type Input, pageInput, typedInput } from "./chats.ts";
import { runConformance } from "./conformance.ts";
import {
	STORAGE_KEY as CREDENTIALS_KEY,
	credentialChanges,
	markStopping,
	stopMarkers,
	unmarkStopping,
} from "./credentials.ts";
import { Drafts, draftEdited } from "./drafts.ts";
import { playAt } from "./media.ts";
import { buildMenus, MENU_ADD, MENU_PAGE_ASK, MENU_PAGE_PRESET, MENU_PRESET } from "./menus.ts";
import {
	credentials,
	hasHostPermission,
	models,
	sentThinking,
	signInEnded,
	startingModel,
	syncPlanWindows,
	verifyKey,
} from "./models.ts";
import { bounded, chromePageAccess, noteLead, PAGE_TIMEOUT_MS, pageMove, watchLeads } from "./page.ts";
import { Pages } from "./pages.ts";
import { EMPTY_CHAT, SELECTION_KIND } from "./projection.ts";
import { watchTabs } from "./screenshot.ts";
import {
	activeWork,
	appendLog,
	asks,
	clearLog,
	commands,
	currentLog,
	currentSession,
	deleteAllChats,
	installPageTools,
	onChange,
	session,
	storageFull,
	tabs,
	wake,
} from "./session.ts";
import {
	defaultSettings,
	loadSettings,
	movedPreset,
	saveSettings,
	settingsChange,
	switchedPreset,
	withoutPreset,
	withPreset,
} from "./settings.ts";
import { UNRESOLVED } from "./tabs.ts";
import { urlKey } from "./url-key.ts";

const workerStartedAt = Date.now();
const ATTACHMENT_KEY = "attachment";
/** How long the first open in a tab waits for the capture's anchor finding before it looks up the tab's chat. */
const ANCHOR_WAIT_MS = 2000;

// The tab changes that drop a screenshot taken during them (design 6.26).
watchTabs();
watchLeads();

chrome.runtime.onInstalled.addListener(() => {
	void buildMenus(true).catch(() => {});
	// The toolbar click goes to `action.onClicked`, which grants activeTab and opens the panel itself.
	void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
	void wake("install");
});

chrome.runtime.onStartup.addListener(() => void wake("browser startup"));

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === RECOVERY_ALARM) {
		void wake("recovery alarm")
			.then(({ harness }) => activeWork.admit(async () => harness.resume()))
			.catch((error: unknown) => console.error("[pi-aside] recovery alarm", error));
	} else if (alarm.name === EXPIRE_ALARM) void tidySignIn().finally(() => refreshAccess());
});

// The ChatGPT callback page hands over OpenAI's redirect (design 6.20): only that page of this extension, in a tab.
// The page agent names the site of a link pi clicks (design 6.28).
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
	const { type, search, url } = (typeof message === "object" && message !== null ? message : {}) as Record<
		string,
		unknown
	>;
	if (
		type === "pi-link" &&
		sender.id === chrome.runtime.id &&
		sender.tab?.id !== undefined &&
		typeof url === "string"
	) {
		noteLead(sender.tab.id, url);
		return false;
	}
	if (
		type !== "chatgpt-callback" ||
		sender.id !== chrome.runtime.id ||
		sender.tab?.id === undefined ||
		!sender.url?.startsWith(chrome.runtime.getURL(CALLBACK_PAGE))
	) {
		return false;
	}
	void completeSignIn(typeof search === "string" ? search : "").then(reply);
	return true;
});

// A worker that Chrome stopped during a build left it unfinished.
void buildMenus(false).catch(() => {});
// One stopped during a sign-in, or before its expiry alarm, may have left its rule or permission behind.
void tidySignIn().catch(() => {});

/** Settings are saved even when the menu fails to update: the reply says why, and the next worker tries again. */
async function menusAfterSave(): Promise<SettingsSaved> {
	try {
		await buildMenus(true);
		return { menuError: null };
	} catch (error) {
		return { menuError: errorText(error) };
	}
}

// Gestures. Each opens the panel of its tab, captures the page, and resolves the tab (design 6.17).

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (tab?.id === undefined) return;
	const item = String(info.menuItemId);
	// The page items act on the tab's top-level page, also after a right-click in a frame, as the toolbar button does.
	if (item === MENU_PAGE_ASK || item.startsWith(MENU_PAGE_PRESET)) {
		const top = tab.url ?? info.pageUrl;
		const started = begin("context-menu", tab, { frameId: 0, url: top, top });
		// The request ID is minted at the click.
		if (item !== MENU_PAGE_ASK) void askPage(started, crypto.randomUUID(), item.slice(MENU_PAGE_PRESET.length));
		return;
	}
	const started = begin("context-menu", tab, {
		frameId: info.frameId ?? 0,
		url: info.frameUrl ?? info.pageUrl,
		top: tab.url ?? info.pageUrl,
		selectionText: info.selectionText,
		editable: info.editable,
	});
	if (item === MENU_ADD) {
		void addSelection(started);
		return;
	}
	// The request ID is minted at the click.
	void askSelection(
		"context-menu",
		started,
		crypto.randomUUID(),
		item.startsWith(MENU_PRESET) ? item.slice(MENU_PRESET.length) : undefined,
	);
});

chrome.commands.onCommand.addListener((command, tab) => {
	if (tab?.id === undefined) return;
	const started = begin("command", tab, { frameId: 0, url: tab.url, top: tab.url });
	if (command === "ask-selection") void askSelection("command", started, crypto.randomUUID(), undefined);
	else if (command === "add-selection") void addSelection(started);
});

chrome.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
});

// A tab's close drops its entry, drafts, and notice; Chrome replacing a tab's contents moves them to the new ID. Both
// are commands, so a send that arrived before finishes first. A tab pi never opened in costs a `storage.session` read.
// A gesture that ends later writes its draft or notice to the tab's new ID, or nowhere.

/** In this worker, the closed tabs, and the new ID of each replaced tab; a gesture does not outlive its worker. */
const closed = new Set<number>();
const replaced = new Map<number, number>();

/** The ID tab `tabId` has now; undefined once it was closed. */
function liveTab(tabId: number): number | undefined {
	let id = tabId;
	for (let next = replaced.get(id); next !== undefined; next = replaced.get(id)) id = next;
	return closed.has(id) ? undefined : id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
	closed.add(tabId);
	tabGestures.delete(tabId);
	notices.delete(tabId);
	sending.delete(tabId);
	void commands(async () => {
		await tabs.load();
		const chat = tabs.get(tabId)?.chat;
		await settleAll(`tab ${tabId} closed`, [
			tabs.get(tabId) === undefined ? Promise.resolve() : tabs.update((entries) => entries.delete(tabId)),
			drafts.removeTab(tabId),
		]);
		return chat;
	}).then(
		(chat) => {
			if (typeof chat === "number")
				void session()
					.then(({ chats }) => chats.release(chat))
					.catch(() => {});
		},
		() => {},
	);
});

chrome.tabs.onReplaced.addListener((added, removed) => {
	replaced.set(removed, added);
	tabGestures.delete(removed);
	for (const shown of [notices, sending] as Map<number, unknown>[]) {
		if (shown.has(removed)) shown.set(added, shown.get(removed));
		shown.delete(removed);
	}
	void commands(async () => {
		await tabs.load();
		const moved = async () => {
			if (tabs.get(removed) === undefined) return;
			// The chat and `rev` move. The old page's document is gone; a gesture in the new ID may already have recorded
			// its own page, URL, and anchor finding, which stay.
			await tabs.update((entries) => {
				const entry = entries.get(removed);
				if (entry === undefined) return;
				entries.delete(removed);
				const { url, anchor, page } = entries.get(added) ?? { ...entry, page: null };
				entries.set(added, { ...entry, url, anchor, page });
			});
			void chrome.sidePanel.setOptions({ tabId: added, path: panelPath(added), enabled: true }).catch(() => {});
		};
		await settleAll(`tab ${removed} replaced by ${added}`, [moved(), drafts.moveTab(removed, added)]);
	}).catch(() => {});
});

/**
 * Runs every step of a tab's drop or move, and logs a failed save. A failed save leaves the old ID's entry, but that ID
 * is no longer open, so `Chats` admits nothing for it.
 */
async function settleAll(what: string, steps: Promise<void>[]): Promise<void> {
	for (const result of await Promise.allSettled(steps)) {
		if (result.status === "rejected") {
			await appendLog(currentSession()?.harness, `${what}: ${errorText(result.reason)}`).catch(() => {});
		}
	}
}

chrome.permissions.onAdded.addListener(() => void refreshAccess());
// Also a change no command made: a refresh, or a ChatGPT sign-in that OpenAI ended (design 6.20).
chrome.storage.local.onChanged.addListener((changes) => {
	if (CREDENTIALS_KEY in changes) void refreshAccess();
});
chrome.permissions.onRemoved.addListener(() => void refreshAccess());

/** What the gesture saw: the frame and its URL, the tab's top-level URL, and for the context menu Chrome's copy of the selection. */
type Gesture = { frameId: number; url?: string; top?: string; selectionText?: string; editable?: boolean };

/** A gesture in progress: its capture, the resolution of its tab, and the tab's `rev` at the gesture. */
type Started = {
	tabId: number;
	top: string | undefined;
	captured: Promise<Attachment>;
	resolved: Promise<void>;
	rev: Promise<number>;
};

let gestures = 0;
/** Per tab, the number of its newest gesture: an older gesture's capture writes nothing over it. */
const tabGestures = new Map<number, number>();
/** Per tab, the resolution of its newest gesture; the `hello` of the panel it opened waits for it. */
const resolutions = new Map<number, Promise<void>>();

/** The panel reads its tab from its path, since a side panel has no tab of its own. */
const panelPath = (tabId: number) => `panel.html?tab=${tabId}`;

/**
 * Opens the tab's panel, captures the page, and resolves the tab. Everything that needs the user gesture, which ends
 * at the first await, happens here: `setOptions()` is not awaited, and `open()` follows it at once. An unresolved tab
 * records the URL before the capture can, so a worker that stops before the lookup leaves it for `hello`.
 */
function begin(via: Attachment["via"], tab: chrome.tabs.Tab, gesture: Gesture): Started {
	const tabId = tab.id!;
	void Promise.allSettled([
		chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true }),
		chrome.sidePanel.open({ tabId }),
	]).then(([options, opened]) => {
		const result = (settled: PromiseSettledResult<void>) =>
			settled.status === "fulfilled" ? "ok" : errorText(settled.reason);
		log(via, `panel ${via}: tab ${tabId}: setOptions ${result(options)}, open ${result(opened)}`);
	});
	const sequence = ++gestures;
	tabGestures.set(tabId, sequence);
	// Queued before any await: commands that arrived before the gesture count, and New chat or History after it rejects
	// the gesture's send, however long the capture and the writes below take.
	const rev = commands(async () => {
		await tabs.load();
		return tabs.get(tabId)?.rev ?? 0;
	});
	void rev.catch(() => {});
	const top = gesture.top;
	let capturedVersion = tabs.captureVersion(tabId);
	const recorded = tabs.update((entries) => {
		const entry = entries.get(tabId);
		capturedVersion = tabs.captureVersion(tabId);
		if (tabGestures.get(tabId) !== sequence || entry?.chat !== undefined) return;
		entries.set(tabId, { ...(entry ?? UNRESOLVED), url: top ?? null, anchor: null });
	});
	// The tab write, not the command queue: captures must still publish while a lifecycle command waits.
	const captured = capture(
		via,
		tab,
		gesture,
		sequence,
		recorded.then(
			() => capturedVersion,
			() => capturedVersion,
		),
	);
	const resolved = resolve(via, tabId, top, recorded, captured);
	resolutions.set(tabId, resolved);
	void resolved
		.catch(() => {})
		.then(() => {
			if (resolutions.get(tabId) === resolved) resolutions.delete(tabId);
		});
	return { tabId, top, captured, resolved, rev };
}

/**
 * Rule 2 for an unresolved tab: waits at most 2 s for the capture's anchor finding, then looks up the tab's chat by
 * the URL key. A capture that answers later changes no key and no chat. A resolved tab resolves at once.
 */
async function resolve(
	via: Attachment["via"],
	tabId: number,
	top: string | undefined,
	recorded: Promise<void>,
	captured: Promise<Attachment>,
): Promise<void> {
	await recorded.catch(() => {});
	if (tabs.get(tabId)?.chat !== undefined) return;
	const anchor = await Promise.race([
		captured.then((attachment) => attachment.anchor ?? null),
		new Promise<null>((done) => setTimeout(() => done(null), ANCHOR_WAIT_MS)),
	]);
	const { chats } = await wake(via);
	await chats.lookup(tabId, top === undefined ? null : urlKey(top, anchor));
}

// The selection action.

/**
 * Sends the selection with a preset, or, for "Ask pi" and the hotkey in compose mode, puts it in the tab's drafts. A
 * send that fails before admission (no key, no permission, the tab's chat changed) becomes a draft with the reason.
 */
async function askSelection(
	via: Attachment["via"],
	started: Started,
	requestId: string,
	presetId: string | undefined,
): Promise<void> {
	const { tabId } = started;
	try {
		const [attachment, current] = await Promise.all([started.captured, loadSettings()]);
		const selection = selectedText(tabId, attachment);
		if (selection === undefined) return;
		// A menu item opened before its prompt was deleted or turned off sends nothing: another prompt is not what was
		// chosen.
		const preset = current.prompts.find((other) => other.id === (presetId ?? current.defaultPreset));
		if (preset === undefined || !presetOn(preset)) {
			notify(tabId, t(preset === undefined ? "promptDeletedNotice" : "promptOffNotice"));
			return;
		}
		const language = effectiveAnswerLanguage(current.language);
		const { url, title } = attachment;
		const data: SelectionData = {
			text: selection,
			preset: presetDisplayName(preset, language),
			page: pageRef(attachment),
		};
		const text = fillTemplate(preset.template, { selection, title, url, language });
		// The chat this selection starts belongs to the tab's top-level page, also when it is sent later as a draft.
		const key = started.top === undefined ? null : urlKey(started.top, attachment.anchor ?? null);
		const draft = { text, selection: data, page: null, prompt: null, key };
		if (presetId === undefined && current.selectionAction === "compose") {
			await addDraft({ ...draft, tabId, note: null, insert: false });
			return;
		}
		await sendGesture(
			via,
			started,
			{
				requestId,
				content: text,
				entry: { kind: SELECTION_KIND, data: { ...data, edited: false } satisfies SelectionEntryData },
			},
			draft,
		);
	} catch (error) {
		notify(tabId, errorText(error));
	}
}

/**
 * A prompt from the menu for the page: sent with the tab's top-level page attached, which the model reads with
 * `read_page` when it needs the text; nothing more is read at the click (design 6.18). A page pi cannot read sends
 * nothing: without its page, the prompt would still be a paid request.
 */
async function askPage(started: Started, requestId: string, presetId: string): Promise<void> {
	const { tabId } = started;
	try {
		const [attachment, current] = await Promise.all([started.captured, loadSettings()]);
		if (attachment.documentId === undefined) {
			notify(tabId, t("pageReadRefused", [attachment.error ?? t("chromeReadRefused")]));
			return;
		}
		const preset = current.prompts.find((other) => other.id === presetId);
		if (preset === undefined || !presetOn(preset)) {
			notify(tabId, t(preset === undefined ? "promptDeletedNotice" : "promptOffNotice"));
			return;
		}
		const language = effectiveAnswerLanguage(current.language);
		const { url, title } = attachment;
		const text = fillTemplate(preset.template, { selection: PAGE_SELECTION, title, url, language });
		const prompt = presetDisplayName(preset, language);
		const key = started.top === undefined ? null : urlKey(started.top, attachment.anchor ?? null);
		const page = pageRef(attachment);
		// The draft keeps the page it was made for: sent later, it does not take the tab's newer page.
		await sendGesture("context-menu", started, pageInput(requestId, text, page, prompt), {
			text,
			selection: null,
			page: { ...page, key },
			prompt,
			key,
		});
	} catch (error) {
		notify(tabId, errorText(error));
	}
}

/**
 * Sends a gesture's input to the tab's chat as the gesture resolved it, with the tab's `rev` at the gesture, not as it
 * is after the capture. A send that fails before admission (no key, no permission, the tab's chat changed) becomes
 * `draft`, with the reason.
 */
async function sendGesture(
	via: Attachment["via"],
	started: Started,
	input: Input,
	draft: Pick<Draft, "text" | "selection" | "page" | "prompt" | "key">,
): Promise<void> {
	const { tabId } = started;
	const mark = storageFull.mark();
	setSending(tabId, 1);
	try {
		await started.resolved;
		const rev = await started.rev;
		const { chats, harness } = await wake(via);
		await offerCurrentTools();
		const id = await chats.send(tabId, rev, null, input, draft.key);
		// Saved, as a send from the panel is (design 8).
		void storageFull.clear(mark);
		await appendLog(harness, `send ${via}: tab ${tabId}: admitted ${id}`).catch(() => {});
	} catch (error) {
		// The send named the old ID of a tab Chrome replaced meanwhile: its draft goes to the new one.
		const note = liveTab(tabId) === tabId ? errorText(error) : t("tabReloadedUnsent");
		await addDraft({ ...draft, tabId, note, insert: false });
	} finally {
		setSending(tabId, -1);
	}
}

/**
 * Before an answer starts: the page tools as the settings and Chrome's Allow User Scripts switch are now. The switch has
 * no event, so turning it on offers run_script from the next answer; a waiting card reads the modes again.
 */
async function offerCurrentTools(): Promise<void> {
	if (await installPageTools(await loadSettings())) asks.recheck();
}

/**
 * "Add to message": only the selected text goes into the tab's message box, with no prompt, whatever the selection
 * action. The capture attaches the page, so the message the user writes around it is about that page.
 */
async function addSelection(started: Started): Promise<void> {
	const { tabId } = started;
	try {
		const selection = selectedText(tabId, await started.captured);
		if (selection !== undefined) {
			await addDraft({
				tabId,
				text: selection,
				selection: null,
				page: null,
				prompt: null,
				key: null,
				note: null,
				insert: true,
			});
		}
	} catch (error) {
		notify(tabId, errorText(error));
	}
}

/** The gesture's selected text, or undefined after the tab was told why there is none. */
function selectedText(tabId: number, attachment: Attachment): string | undefined {
	const { selection } = attachment;
	if (selection !== undefined && selection.trim() !== "") return selection;
	notify(tabId, attachment.error ? t("selectionReadFailed", [attachment.error]) : t("selectTextFirst"));
	return undefined;
}

/**
 * Runs in the page. Selections inside inputs are not part of `getSelection()`; password fields are never read. In the
 * top page, it also checks whether the URL's fragment names an element by ID or an `<a name>`, as the browser scrolls
 * to: then it is a place in the page, not an app's state (design 6.17).
 */
function readFrame(readSelection = true): {
	url: string;
	title: string;
	selection: string;
	password: boolean;
	anchor: boolean | null;
} {
	let anchor: boolean | null = null;
	const fragment = window === window.top ? location.hash.slice(1) : "";
	if (fragment !== "") {
		let decoded = fragment;
		try {
			decoded = decodeURIComponent(fragment);
		} catch {
			// Not percent-encoded text: the fragment as it is names the element.
		}
		anchor = [fragment, decoded].some(
			(name) =>
				document.getElementById(name) !== null ||
				[...document.getElementsByName(name)].some((element) => element.tagName === "A"),
		);
	}
	const page = { url: location.href, title: document.title, anchor };
	// New chat refreshes metadata only: do not inspect focus, selection, or form field values.
	if (!readSelection) return { ...page, selection: "", password: false };
	let active = document.activeElement;
	// A field inside a web component is the shadow root's active element, not the document's.
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
	if (active instanceof HTMLInputElement && active.type === "password")
		return { ...page, selection: "", password: true };
	if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
		const { selectionStart, selectionEnd, value } = active;
		if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) {
			return { ...page, selection: value.slice(selectionStart, selectionEnd), password: false };
		}
	}
	return { ...page, selection: window.getSelection()?.toString() ?? "", password: false };
}

const withoutFragment = (url: string) => url.split("#")[0];
/** The newest capture, also kept in `storage.session` for the next worker. */
let lastAttachment: Attachment | undefined;

const pageRef = (attachment: Attachment): PageRef => ({
	tabId: attachment.tabId,
	frameId: attachment.frameId,
	documentId: attachment.documentId ?? null,
	url: attachment.url,
	title: attachment.title,
	capturedAt: attachment.capturedAt,
});

async function capture(
	via: Attachment["via"],
	tab: chrome.tabs.Tab,
	gesture: Gesture,
	sequence: number,
	version: Promise<number>,
): Promise<Attachment> {
	const tabId = tab.id!;
	const { frameId } = gesture;
	const attachment: Attachment = {
		via,
		tabId,
		frameId,
		url: (gesture.url ?? tab.url ?? "").slice(0, MAX_URL_CHARS),
		title: pageTitle(tab.title ?? ""),
		capturedAt: Date.now(),
	};
	// Leaves the watcher for where the page sends the tab, while the gesture lets pi script it (design 6.28).
	void chromePageAccess.top(tabId);
	let password = false;
	/** The script read the gesture's document and found no password field. */
	let checked = false;
	try {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, frameIds: [frameId] },
			func: readFrame,
		});
		const frame = injection?.result;
		if (injection !== undefined && frame !== undefined) {
			if (gesture.url !== undefined && withoutFragment(frame.url) !== withoutFragment(gesture.url)) {
				// The frame navigated after the gesture: its document is not the one the selection came from.
				attachment.error = "the page changed before it was read";
			} else {
				if (frame.anchor !== null) attachment.anchor = frame.anchor;
				if (frame.password) {
					password = true;
				} else {
					checked = true;
					attachment.documentId = injection.documentId;
					attachment.url = frame.url.slice(0, MAX_URL_CHARS);
					attachment.title = pageTitle(frame.title);
					if (frame.selection !== "") {
						attachment.selection = frame.selection;
						attachment.selectionSource = "dom";
					}
				}
			}
		}
	} catch (error) {
		attachment.error = errorText(error);
	}
	// Chrome's flattened copy covers frames and pages the script could not read. It is used only where it cannot come
	// from a password field: the script checked the document, or the selection is not in an editable field.
	if (password) attachment.error = "a password field has focus";
	else if (attachment.selection === undefined && gesture.selectionText && (checked || gesture.editable === false)) {
		attachment.selection = gesture.selectionText;
		attachment.selectionSource = "selectionText";
	}
	const where = `tab ${tabId} ${attachment.url || "(no url)"} frame ${frameId} document ${attachment.documentId ?? "-"}`;
	const what =
		attachment.selection === undefined
			? "no selection"
			: `${attachment.selection.length} chars via ${attachment.selectionSource}`;
	log(via, `capture ${via}: ${where}; ${what}${attachment.error ? `; error: ${attachment.error}` : ""}`);
	// Only the newest gesture that has not crossed New chat or History records its page.
	// An unreadable page attaches nothing. The key belongs to this gesture's top-level page.
	const key = gesture.top === undefined ? null : urlKey(gesture.top, attachment.anchor ?? null);
	const capturedVersion = await version;
	await tabs
		.update((entries) => {
			if (tabGestures.get(tabId) !== sequence || tabs.captureVersion(tabId) !== capturedVersion) return;
			entries.set(tabId, {
				...(entries.get(tabId) ?? UNRESOLVED),
				url: gesture.top ?? null,
				anchor: attachment.anchor ?? null,
				page: attachment.documentId === undefined ? null : { ...pageRef(attachment), key },
			});
		})
		.catch(() => {});
	if (sequence === gestures) {
		lastAttachment = attachment;
		await chrome.storage.session.set({ [ATTACHMENT_KEY]: attachment }).catch(() => {});
	}
	schedule();
	return attachment;
}

/** Refreshes a fresh chat's attachment without holding the shared command queue or reading page content. */
async function refreshPage(tabId: number, rev: number, sequence: number | undefined): Promise<void> {
	const current = () => liveTab(tabId) === tabId && tabGestures.get(tabId) === sequence;
	if (!current() || tabs.get(tabId)?.rev !== rev) return;
	const capturedAt = Date.now();
	const [injection] = await bounded(
		() =>
			chrome.scripting.executeScript({
				target: { tabId, frameIds: [0] },
				func: readFrame,
				args: [false],
			}),
		BACKGROUND_CONTEXT,
		PAGE_TIMEOUT_MS,
	);
	if (injection === undefined || injection.result == null || !injection.documentId) return;
	const frame = injection.result;
	if (siteOrigin(frame.url) === null) return;
	const anchor = frame.anchor ?? null;
	const page = {
		tabId,
		frameId: 0,
		documentId: injection.documentId,
		capturedAt,
		url: frame.url.slice(0, MAX_URL_CHARS),
		title: pageTitle(frame.title),
		key: urlKey(frame.url, anchor),
	};
	await tabs.update((entries) => {
		const entry = entries.get(tabId);
		if (!current() || entry?.rev !== rev) return;
		entries.set(tabId, { ...entry, url: frame.url, anchor, page });
	});
}

/** Diagnostics only: a Harness that cannot open must not stop the gesture. */
function log(via: Attachment["via"], line: string): void {
	void wake(via).then(
		({ harness }) => appendLog(harness, line).catch(() => {}),
		() => appendLog(undefined, line),
	);
}

// Pages: the side panels and the diagnostics page.

const drafts = new Drafts(() => schedule());

/**
 * A draft from a gesture, which may end after its tab was replaced or closed. Drafts saves in call order, so a move or
 * drop that runs later takes it too.
 */
async function addDraft(fields: Omit<Draft, "id" | "createdAt">): Promise<void> {
	const tabId = liveTab(fields.tabId);
	if (tabId !== undefined) await drafts.add({ ...fields, tabId });
}
/** Per tab, its gesture sends, a selection's or a page prompt's, between the click and admission. */
const sending = new Map<number, number>();
const notices = new Map<number, Notice>();
let settings: Settings = defaultSettings();
let harnessError: string | null = null;
/** Tabs whose page is between its `hello` and its snapshot: their chats' views stay. */
const greeting = new Map<number, number>();
/** Ports that disconnected; a `hello` that ends later registers nothing for them. */
const disconnected = new WeakSet<chrome.runtime.Port>();

const pages = new Pages((tabId, log): PanelState => {
	const tab = tabId === null ? undefined : tabs.get(tabId);
	const chat = tab?.chat;
	return {
		status: status(),
		settings,
		chat:
			typeof chat === "number"
				? (currentSession()?.chats.view(chat) ?? { ...EMPTY_CHAT, conversationId: chat })
				: EMPTY_CHAT,
		rev: tab?.rev ?? 0,
		resumed: tab?.resumed ?? null,
		drafts: tabId === null ? [] : drafts.forTab(tabId),
		sending: tabId === null ? 0 : (sending.get(tabId) ?? 0),
		page: tab?.page ?? null,
		notice: tabId === null ? null : (notices.get(tabId) ?? null),
		asks: typeof chat === "number" ? asks.cards(chat) : [],
		log: log ? [...currentLog()] : [],
	};
});

/** Keeps the views of the chats that connected pages show, and drops the others. */
function retainViews(): void {
	const chats = currentSession()?.chats;
	if (chats === undefined) return;
	const shown = new Set<number>();
	for (const tabId of [...pages.tabs(), ...greeting.keys()]) {
		const chat = tabs.get(tabId)?.chat;
		if (typeof chat === "number") shown.add(chat);
	}
	chats.retain(shown);
}

let scheduled = false;
/** Coalesces a burst of changes into one batch per page. Nothing is built while no page is connected. */
function schedule(): void {
	if (scheduled || pages.size === 0) return;
	scheduled = true;
	setTimeout(() => {
		scheduled = false;
		retainViews();
		pages.flush();
	}, 50);
}
onChange(schedule);

function notify(tabId: number, text: string): void {
	const live = liveTab(tabId);
	if (live === undefined) return;
	notices.set(live, { id: crypto.randomUUID(), text });
	schedule();
}

function setSending(tabId: number, change: number): void {
	const live = liveTab(tabId);
	if (live === undefined) return;
	const count = (sending.get(live) ?? 0) + change;
	if (count > 0) sending.set(live, count);
	else sending.delete(live);
	schedule();
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== PANEL_PORT) return;
	// Privileged commands are accepted only from this extension's own pages.
	if (port.sender?.id !== chrome.runtime.id || !port.sender.url?.startsWith(chrome.runtime.getURL(""))) {
		port.disconnect();
		return;
	}
	port.onDisconnect.addListener(() => {
		disconnected.add(port);
		pages.remove(port);
		retainViews();
	});
	port.onMessage.addListener((message: PageMessage) => {
		if (message.type === "hello") void hello(port, message);
		else if (message.type === "ack") pages.ack(port, message.seq);
		else void handle(port, message.id, message.command);
	});
});

/**
 * The snapshot shows stored values; a failed read shows defaults and is read again on the next change. It waits for
 * the tab's chat too: Chrome stops an idle worker after about 30 s and an open panel reconnects to the next one, which
 * must send the chat the panel shows. A snapshot without it cleared the transcript and closed Settings each time.
 */
async function hello(port: chrome.runtime.Port, message: Extract<PageMessage, { type: "hello" }>): Promise<void> {
	const { tabId } = message;
	if (tabId !== null) greeting.set(tabId, (greeting.get(tabId) ?? 0) + 1);
	try {
		await Promise.allSettled([
			loadSettings().then((value) => {
				settings = value;
			}),
			drafts.load(),
			loadAccess(),
			tabs.load(),
			storageFull.load(),
			wake("panel").then(
				() => {
					harnessError = null;
				},
				(error: unknown) => {
					harnessError = errorText(error);
					void storageFull.note(error);
				},
			),
		]);
		if (tabId !== null) await showTab(tabId).catch(() => {});
		if (!disconnected.has(port)) pages.hello(port, message);
	} finally {
		if (tabId !== null) {
			const count = (greeting.get(tabId) ?? 1) - 1;
			if (count > 0) greeting.set(tabId, count);
			else greeting.delete(tabId);
		}
		// A page that left during its hello no longer keeps its chat's view; its disconnect counted the greeting.
		if (disconnected.has(port)) retainViews();
	}
}

/**
 * Waits for the resolution the tab's gesture began, or runs the lookup a stopped worker left: the tab recorded its URL
 * but has no chat yet. Then attaches the view of the tab's chat. A tab that recorded nothing stays unresolved.
 */
async function showTab(tabId: number): Promise<void> {
	const pending = resolutions.get(tabId);
	if (pending !== undefined) {
		await pending.catch(() => {});
	} else {
		const tab = tabs.get(tabId);
		if (tab !== undefined && tab.chat === undefined && tab.url !== null) {
			await (await session()).chats.lookup(tabId, urlKey(tab.url, tab.anchor));
		}
	}
	const chat = tabs.get(tabId)?.chat;
	if (typeof chat === "number") await (await session()).chats.attach(chat);
}

/**
 * Commands whose success shows the storage has room again: they saved a new input, or erased every chat (design 8).
 * Remove from History only hides a chat; its data stays (6.30).
 */
const FREES_STORAGE = new Set<Command["type"]>(["send", "retry", "edit", "delete-all-chats"]);

async function handle(port: chrome.runtime.Port, id: string, command: Command): Promise<void> {
	const mark = storageFull.mark();
	try {
		const result = await run(command, pages.tabOf(port) ?? null);
		if (FREES_STORAGE.has(command.type)) void storageFull.clear(mark);
		pages.reply(port, { type: "reply", id, ok: true, result: result ?? null });
	} catch (error) {
		void storageFull.note(error);
		pages.reply(port, { type: "reply", id, ok: false, error: errorText(error) });
	}
	schedule();
}

function needTab(tabId: number | null): number {
	if (tabId === null) throw new Error(t("pageHasNoChat"));
	return tabId;
}

async function run(command: Command, tabId: number | null): Promise<unknown> {
	switch (command.type) {
		case "send": {
			const tab = needTab(tabId);
			const { chats, harness } = await session();
			await offerCurrentTools();
			const draft = command.draftId === null ? undefined : drafts.get(command.draftId);
			const quoted = command.quote ? draft?.selection : undefined;
			const { page, requestId, text, whenBusy } = command;
			const attachments = attached(checkAttachments(command.attachments));
			let input: Input = typedInput(requestId, text, attachments);
			let key: string | null = null;
			if (quoted != null && draft !== undefined) {
				input = {
					requestId,
					content: withAttachments(text, attachments.blocks),
					entry: {
						kind: SELECTION_KIND,
						data: {
							...quoted,
							edited: draftEdited(text, draft.text),
							...(attachments.infos.length === 0 ? {} : { attachments: attachments.infos }),
						} satisfies SelectionEntryData,
					},
				};
				key = draft.key;
			} else if (page?.documentId != null) {
				// The key came with the page from the gesture that captured it; the entry keeps only the page. A page
				// prompt's draft sent with its own page and its text unchanged keeps the prompt's name (design 6.18).
				const { key: pageKey, ...ref } = page;
				const prompt =
					draft?.prompt != null && draft.page?.documentId === ref.documentId && !draftEdited(text, draft.text)
						? draft.prompt
						: undefined;
				// The tab may have left the attached page since its gesture: the model is told where it is (design 6.28).
				input = pageInput(requestId, text, ref, prompt, await pageMove(ref), attachments);
				key = pageKey;
			}
			const id = await chats.send(tab, command.rev, command.conversationId, { ...input, whenBusy }, key);
			if (command.draftId !== null) await drafts.remove(command.draftId).catch(() => {});
			await appendLog(harness, `send panel: tab ${tab}: admitted ${id}`).catch(() => {});
			return Number(id);
		}
		case "retry": {
			const { chats } = await session();
			await offerCurrentTools();
			return Number(
				await chats.retry(needTab(tabId), command.rev, command.conversationId, command.entryId, command.requestId),
			);
		}
		case "edit": {
			const { chats } = await session();
			await offerCurrentTools();
			const { rev, conversationId, entryId, text, keep, requestId } = command;
			if (!Array.isArray(keep)) throw new Error(t("attachmentGone"));
			return Number(await chats.edit(needTab(tabId), rev, conversationId, entryId, text, keep, requestId));
		}
		case "abort": {
			const tab = needTab(tabId);
			// Inputs Stop withdrew from the queue come back as drafts, so what the user wrote is not lost.
			for (const { text, lost } of await (await session()).chats.abort(tab, command.rev))
				await addDraft({
					tabId: tab,
					text,
					selection: null,
					page: null,
					prompt: null,
					key: null,
					// Drafts keep text only (design 6.42): an input of attachments alone still shows that it was withdrawn.
					note: lost > 0 ? t("attachmentsNotKept") : null,
					insert: false,
				});
			return;
		}
		case "new-chat": {
			const tab = needTab(tabId);
			const sequence = tabGestures.get(tab);
			await (await session()).chats.newChat(tab, command.rev);
			if (command.attachPage)
				void refreshPage(tab, command.rev + 1, sequence).catch((error) =>
					appendLog(currentSession()?.harness, `New chat page refresh: ${errorText(error)}`).catch(() => {}),
				);
			return undefined;
		}
		case "open-chat":
			return (await session()).chats.openChat(needTab(tabId), command.rev, command.target, command.createdAt);
		case "list-chats":
			return (await session()).chats.list(tabId);
		case "rename-chat":
			return (await session()).chats.rename(command.target, command.title, command.createdAt);
		case "remove-chat":
			return (await session()).chats.remove(command.target, command.createdAt);
		case "restore-chat":
			return (await session()).chats.restore(command.target, command.createdAt);
		case "export-chat":
			return (await session()).chats.markdown(command.target, Date.now(), command.createdAt);
		case "delete-all-chats":
			await deleteAllChats();
			await drafts.clear();
			return undefined;
		case "set-model": {
			const { provider, modelId } = command.model;
			if (!isProvider(provider) || models.getModel(provider, modelId) === undefined) {
				throw new Error(t("modelUnknown", [provider, modelId]));
			}
			await (await session()).chats.setModel(needTab(tabId), command.rev, { provider, modelId });
			settings = await loadSettings();
			return undefined;
		}
		case "set-settings": {
			const change = settingsChange(command.settings);
			let chosen: ToolModes | undefined;
			settings = await saveSettings((current) => {
				chosen = current.tools;
				return change(current);
			});
			// The page tools offered follow the modes; a waiting card reads them again (design 6.23). Compared with the
			// tools installed, not the settings before: saves from two panels may cross.
			// Saved already: a session that cannot open now installs the tools from the saved settings when it opens.
			const open = await session().then(
				() => true,
				(error: unknown) => {
					console.error("[pi-aside] page tools wait for the session", error);
					return false;
				},
			);
			const installed = open && (await installPageTools(settings));
			// Also when the tools offered stay the same, as while Chrome blocks scripts: a change of the modes the user
			// chose takes back what was allowed under the modes that were.
			if (installed || JSON.stringify(chosen) !== JSON.stringify(settings.tools)) asks.recheck();
			return menusAfterSave();
		}
		case "save-prompt":
			settings = await saveSettings((current) => ({ prompts: withPreset(current.prompts, command.prompt) }));
			return menusAfterSave();
		case "delete-prompt":
			settings = await saveSettings((current) => ({ prompts: withoutPreset(current.prompts, command.promptId) }));
			return menusAfterSave();
		case "switch-prompt":
			settings = await saveSettings((current) => ({
				prompts: switchedPreset(current.prompts, command.promptId, command.on, current.defaultPreset),
			}));
			return menusAfterSave();
		case "move-prompt":
			settings = await saveSettings((current) => ({
				prompts: movedPreset(current.prompts, command.promptId, command.by),
			}));
			return menusAfterSave();
		case "reset-prompts":
			settings = await saveSettings({ prompts: [...PRESETS] });
			return menusAfterSave();
		case "discard-draft":
			return drafts.remove(command.draftId);
		case "dismiss-notice":
			for (const [tab, notice] of notices) if (notice.id === command.noticeId) notices.delete(tab);
			return undefined;
		case "answer-ask": {
			const chat = tabs.get(needTab(tabId))?.chat;
			const card = typeof chat === "number" ? asks.cards(chat).find(({ id }) => id === command.askId) : undefined;
			if (card === undefined) throw new Error(t("questionGone"));
			const { answer } = command;
			const scope = answer === "answer" || answer === "chat" ? answer : "once";
			if (!asks.answer(command.askId, answer !== "deny", scope)) throw new Error(t("questionGone"));
			return undefined;
		}
		case "get-image":
			return (await session()).chats.image(needTab(tabId), command.entryId, command.index);
		case "play-at":
			return playAt(needTab(tabId), command.url);
		case "set-key":
			return setKey(command.provider, command.key.trim());
		case "chatgpt-sign-in":
			return beginSignIn(command.tabId, command.another);
		case "chatgpt-cancel":
			await cancelSignIn();
			await refreshAccess();
			return undefined;
		case "chatgpt-sign-out":
			return signOut();
		case "verify-key": {
			const check = await verifyKey(command.provider);
			// Verify of a ChatGPT sign-in also updates the plan's models.
			await refreshAccess();
			await appendLog(
				(await session()).harness,
				`verify ${command.provider}: ${check.result}${check.status ? ` (${check.status})` : ""}`,
			);
			return check;
		}
		case "list-models":
			return (Object.keys(PROVIDERS) as ProviderId[]).flatMap((provider) =>
				models.getModels(provider).map(
					(model): ModelInfo => ({
						provider,
						id: model.id,
						name: model.name,
						api: model.api,
						reasoning: model.reasoning,
						thinking: sentThinking(model),
						contextWindow: model.contextWindow,
					}),
				),
			);
		case "set-keepalive":
			await activeWork.setEnabled(command.enabled);
			await appendLog((await session()).harness, `keepalive ${command.enabled ? "enabled" : "disabled"}`);
			return undefined;
		case "conformance": {
			const { harness } = await session();
			await appendLog(harness, "conformance: running against IndexedDB");
			const results = await runConformance();
			const failed = results.filter((result) => !result.ok);
			const ms = results.reduce((sum, result) => sum + result.ms, 0);
			await appendLog(
				harness,
				`conformance: ${results.length - failed.length}/${results.length} passed in ${ms} ms`,
			);
			for (const failure of failed) await appendLog(harness, `conformance FAIL ${failure.name}: ${failure.error}`);
			return results;
		}
		case "clear-log":
			return clearLog();
	}
}

/**
 * Saving a key never sends anything. The first key also picks the model of new chats when the current default's
 * provider has no key. Removing a key stops the chats with work on its provider (design 6.20).
 */
async function setKey(provider: ProviderId, key: string): Promise<void> {
	if (key !== "" && subscriptionToken(provider, key)) throw new Error(t("subscriptionRefused"));
	await credentialChanges(async () => {
		if ((await credentials.read(provider))?.type === "oauth") throw new Error(SIGN_OUT_FIRST);
		if (key === "") {
			await removeCredential(provider);
			return;
		}
		await finishStop(provider);
		try {
			await credentials.modify(provider, async () => ({ type: "api_key", key }));
		} finally {
			await refreshAccess();
		}
	});
	const current = await loadSettings();
	if (key !== "" && access?.[current.model.provider].key === false) {
		settings = await saveSettings({ model: { provider, modelId: RECOMMENDED_MODELS[provider] } });
	}
	await appendLog((await session()).harness, `key ${key === "" ? "removed" : "saved"} for ${provider}`);
}

/**
 * Deletes a provider's credential, then stops the chats with work on it (design 6.20), and returns the credential as
 * it was deleted, after a refresh that held the store's lock. Runs in `credentialChanges`, so no other credential is
 * saved before that work has stopped. The marker lets the next worker start stop the work before anything resumes, if
 * a worker stop cuts this short.
 */
async function removeCredential(provider: ProviderId): Promise<Credential | undefined> {
	const token = await markStopping(provider);
	let removed: Credential | undefined;
	try {
		removed = await credentials.take(provider);
	} finally {
		await refreshAccess();
	}
	// Not through the marker: a worker start may remove it meanwhile, having stopped only the work it found.
	await (await session()).chats.stopProvider(provider);
	await unmarkStopping(provider, token);
	return removed;
}

/** Stops the work of a removed credential that a removal has not stopped yet: the first step of each change. */
async function finishStop(provider: ProviderId): Promise<void> {
	const token = (await stopMarkers())[provider];
	if (token === undefined) return;
	await (await session()).chats.stopProvider(provider);
	await unmarkStopping(provider, token);
}

// Sign in with ChatGPT (design 6.20). One OpenAI credential: a key or a sign-in.

const SIGN_OUT_FIRST = t("signOutFirst");

async function beginSignIn(tabId: number | null, another: boolean): Promise<void> {
	const current = await credentials.read("openai");
	if (current?.type === "api_key") throw new Error(t("removeKeyToSignIn"));
	// Another account's sign-in would replace this one's without ending its session.
	if (another && current?.type === "oauth") throw new Error(SIGN_OUT_FIRST);
	// Without host access to the loopback port the rule does not apply, and the code would go to that port.
	if (!(await chrome.permissions.contains({ origins: [...PLAN_ORIGINS, CHATGPT.loopback] }))) {
		throw new Error(t("signInPermissionMissing"));
	}
	await startSignIn(tabId ?? undefined, credentials, another);
	await refreshAccess();
	await appendLog((await session()).harness, "ChatGPT sign-in started");
}

/**
 * Like a first key (7.1), a sign-in sets the default model when its provider has no credential; also when it is an
 * OpenAI model the plan does not offer. Not when pi knows none of the plan's models.
 */
async function completeSignIn(search: string): Promise<{ ok: true; welcome: boolean } | { ok: false; error: string }> {
	try {
		// A removal cut short by a worker stop: its work stops before a sign-in can take over.
		await credentialChanges(() => finishStop("openai"));
		const { welcome, credential } = await finishSignIn(search, credentials);
		await refreshAccess();
		const planModels = credential.planModels ?? null;
		const { provider, modelId } = (await loadSettings()).model;
		const starting = startingModel("openai", planModels);
		if (
			starting !== null &&
			(access?.[provider].key === false ||
				(provider === "openai" && planModels !== null && !planModels.includes(modelId)))
		) {
			settings = await saveSettings({ model: { provider: "openai", modelId: starting } });
		}
		await appendLog((await session()).harness, "ChatGPT sign-in saved");
		return { ok: true, welcome };
	} catch (error) {
		await refreshAccess();
		await appendLog((await session()).harness, `ChatGPT sign-in failed: ${errorText(error)}`).catch(() => {});
		return { ok: false, error: errorText(error) };
	}
}

/**
 * Deletes the sign-in and stops the chats with OpenAI work, then asks OpenAI to end the session. The account stays
 * saved for the next sign-in. `revoked`: OpenAI confirmed, or had ended the session itself.
 */
async function signOut(): Promise<{ revoked: boolean }> {
	// A sign-in still finishing is not stored after this.
	await cancelSignIn();
	const removed = await credentialChanges(async () => {
		const stored = await credentials.read("openai");
		if (stored?.type !== "oauth") return undefined;
		// First, so a worker stop cannot lose the registration that the next sign-in reuses.
		await keepAccount(stored);
		return removeCredential("openai");
	});
	// The refresh token deleted, not the one read before: a refresh may have replaced it meanwhile.
	if (removed?.type !== "oauth") return { revoked: true };
	const revoked = signInEnded(removed) || (await revoke(removed));
	await appendLog((await session()).harness, `ChatGPT signed out${revoked ? "" : "; OpenAI did not confirm"}`);
	return { revoked };
}

// Status. Its inputs are kept in memory: building it makes no extension API call, because each call keeps the worker
// alive, which would hide what the keepalive switch is meant to show.

let access: Status["access"] | undefined;
let chatgpt: Status["chatgpt"] = { waiting: false, account: null, ended: false };
let accessLoaded: Promise<void> | undefined;
let attachmentLoaded: Promise<void> | undefined;

function loadAccess(): Promise<void> {
	attachmentLoaded ??= chrome.storage.session.get(ATTACHMENT_KEY).then((stored) => {
		lastAttachment ??= stored[ATTACHMENT_KEY] as Attachment | undefined;
	});
	void tabs.load().catch(() => {});
	if (accessLoaded === undefined) {
		const loading = (async () => {
			const next = {} as Status["access"];
			for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
				const credential = await credentials.read(provider);
				const plan = credential?.type === "oauth" && provider === "openai";
				const planModels = plan ? credential.planModels : undefined;
				next[provider] = {
					key: credential !== undefined,
					permission: await hasHostPermission(provider, credential),
					plan,
					planModels:
						Array.isArray(planModels) && planModels.every((id) => typeof id === "string") ? planModels : null,
				};
			}
			access = next;
			await syncPlanWindows();
			const account = await savedAccount(credentials);
			chatgpt = {
				waiting: await signInWaiting(),
				account: account === null ? null : { email: account.email },
				ended: signInEnded(await credentials.read("openai")),
			};
			schedule();
		})();
		accessLoaded = loading;
		loading.catch(() => {
			if (accessLoaded === loading) accessLoaded = undefined;
		});
	}
	return Promise.all([accessLoaded, attachmentLoaded.catch(() => {})]).then(() => {});
}

function refreshAccess(): Promise<void> {
	accessLoaded = undefined;
	return loadAccess().catch(() => {});
}

function status(): Status {
	const opened = currentSession();
	const latest = activeWork.latest;
	return {
		boot: opened?.boot ?? 0,
		workerStartedAt,
		harnessOpenMs: opened?.openMs ?? null,
		harnessError,
		storageFull: storageFull.full,
		access:
			access ??
			(Object.fromEntries(
				Object.keys(PROVIDERS).map((provider) => [
					provider,
					{ key: false, permission: false, plan: false, planModels: null },
				]),
			) as Status["access"]),
		chatgpt,
		wake: latest === undefined ? null : { active: latest.active, at: latest.at ?? null },
		keepaliveEnabled: activeWork.enabled,
		keepalive: activeWork.keepalive,
		attachment: lastAttachment ?? null,
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
