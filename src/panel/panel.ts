// Side panel: UI only. All state lives in the service worker; this page renders what the worker sends and sends
// commands. Model output is never parsed as HTML: answers are Markdown built into DOM nodes (markdown.ts), and
// questions, quotes, and titles are text nodes.

import { attached, MAX_ATTACHMENTS, MAX_FILES_CHARS } from "../shared/attachments.ts";
import { interfaceLocale, localizeDocument, t } from "../shared/i18n.ts";
import { effectiveAnswerLanguage } from "../shared/language.ts";
import { linkTime } from "../shared/media-link.ts";
import {
	ANSWER,
	MAX_PRESET_NAME,
	MAX_PRESETS,
	MAX_TEMPLATE_CHARS,
	PRESET_VARIABLES,
	PRESETS,
	type Preset,
	type PresetVariable,
	presetDisplayName,
	presetError,
	presetOn,
	unknownVariables,
} from "../shared/presets.ts";
import {
	type AskCard,
	type AskReply,
	type AttachedPage,
	type AttachmentInfo,
	CALLS_PER_ANSWER,
	CHATGPT,
	type ChatEntry,
	type ChatExport,
	type ChatSummary,
	type Draft,
	isAnswerLanguage,
	isThinking,
	isWhenBusy,
	MAX_CHAT_TITLE,
	type MessageAttachment,
	type ModelChoice,
	type ModelInfo,
	type PageMove,
	type PanelState,
	PROVIDERS,
	type ProviderId,
	type QueuedInput,
	RECOMMENDED_MODELS,
	type Settings,
	type SettingsChange,
	type SettingsSaved,
	type StoredImage,
	sameEntry,
	subscriptionToken,
	type ToolModes,
	type WhenBusy,
} from "../shared/protocol.ts";
import { runScriptBuilt, userScriptsAllowed } from "../shared/user-scripts.ts";
import { prepare } from "./attach.ts";
import { type Connection, pageTab, WorkerClient } from "./client.ts";
import { attachedPage as choosePage } from "./compose.ts";
import { type DiagramColors, Diagrams, MAX_DIAGRAMS } from "./diagram.ts";
import {
	allowedSites,
	answerError,
	answerHelp,
	answerLine,
	composerStatus,
	contextText,
	fileName,
	filterModels,
	groupChats,
	historyTime,
	hostOf,
	isLong,
	modelName,
	modelTags,
	offeredModels,
	originName,
	pageAddress,
	progressLine,
	providerStatus,
	resumedText,
	sameModel,
	shortModel,
	siteName,
	sitePattern,
	thinkingPicker,
	usageHelp,
	usageText,
	useModelState,
	verifyText,
} from "./format.ts";
import { renderAnswer, safeHref } from "./markdown.ts";
import { expandCommand, matchingCommands, type SlashCommand, slashCommands } from "./slash.ts";

localizeDocument(document);

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`missing #${id}`);
	return found as T;
}

const ui = {
	model: element<HTMLButtonElement>("model"),
	modelName: element("model-name"),
	modelProvider: element("model-provider"),
	chatUsage: element("chat-usage"),
	newChat: element<HTMLButtonElement>("new-chat"),
	openHistory: element<HTMLButtonElement>("open-history"),
	openSettings: element<HTMLButtonElement>("open-settings"),
	reconnecting: element("reconnecting"),
	incompatible: element("incompatible"),
	reloadPage: element<HTMLButtonElement>("reload-page"),
	harnessError: element("harness-error"),
	storageFull: element("storage-full"),
	notice: element("notice"),
	noticeText: element("notice-text"),
	dismissNotice: element<HTMLButtonElement>("dismiss-notice"),
	chatView: element("chat-view"),
	setup: element("setup"),
	setupTitle: element("setup-title"),
	setupKey: element("setup-key"),
	setupProviders: element("setup-providers"),
	setupAllow: element("setup-allow"),
	setupAllowText: element("setup-allow-text"),
	setupGrant: element<HTMLButtonElement>("setup-grant"),
	setupPlan: element("setup-plan"),
	setupChatGPT: element<HTMLButtonElement>("setup-chatgpt"),
	setupResult: element("setup-result"),
	transcript: element("transcript"),
	jump: element<HTMLButtonElement>("jump"),
	viewer: element<HTMLDialogElement>("viewer"),
	viewerImage: element<HTMLImageElement>("viewer-image"),
	drafts: element("drafts"),
	chips: element("chips"),
	quote: element("quote"),
	quoteText: element("quote-text"),
	removeQuote: element<HTMLButtonElement>("remove-quote"),
	page: element("page"),
	pageText: element("page-text"),
	detachPage: element<HTMLButtonElement>("detach-page"),
	allowSite: element<HTMLButtonElement>("allow-site"),
	attachments: element("attachments"),
	attach: element<HTMLButtonElement>("attach"),
	attachInput: element<HTMLInputElement>("attach-input"),
	composer: element<HTMLTextAreaElement>("composer"),
	slashMenu: element("slash-menu"),
	composerStatus: element("composer-status"),
	modelPopup: element("model-popup"),
	modelFilter: element<HTMLInputElement>("model-filter"),
	modelList: element("model-list"),
	modelMissing: element("model-missing"),
	modelResult: element("model-result"),
	thinkingPicker: element("thinking-picker"),
	thinking: element<HTMLSelectElement>("thinking"),
	stop: element<HTMLButtonElement>("stop"),
	send: element<HTMLButtonElement>("send"),
	planNote: element("plan-note"),
	planUsage: element<HTMLAnchorElement>("plan-usage"),
	history: element("history"),
	historyFilter: element<HTMLInputElement>("history-filter"),
	historyNote: element("history-note"),
	historyList: element("history-list"),
	closeHistory: element<HTMLButtonElement>("close-history"),
	settings: element("settings"),
	sendingSaved: element("sending-saved"),
	language: element<HTMLSelectElement>("language"),
	languageSaved: element("language-saved"),
	toolsSaved: element("tools-saved"),
	userScripts: element("user-scripts"),
	userScriptsRow: element("user-scripts-row"),
	toolScript: element("tool-script"),
	openDetails: element<HTMLButtonElement>("open-details"),
	callsPerAnswer: element<HTMLInputElement>("calls-per-answer"),
	promptsSaved: element("prompts-saved"),
	prompts: element("prompts"),
	promptsActions: element("prompts-actions"),
	addPrompt: element<HTMLButtonElement>("add-prompt"),
	resetPrompts: element<HTMLButtonElement>("reset-prompts"),
	resetConfirm: element("reset-confirm"),
	confirmReset: element<HTMLButtonElement>("confirm-reset"),
	cancelReset: element<HTMLButtonElement>("cancel-reset"),
	promptsResult: element("prompts-result"),
	keys: element("keys"),
	sites: element("sites"),
	allowAllSites: element<HTMLButtonElement>("allow-all-sites"),
	sitesResult: element("sites-result"),
	sitesProviders: element("sites-providers"),
	sitesHeld: element("sites-held"),
	shortcuts: element("shortcuts"),
	editShortcuts: element<HTMLButtonElement>("edit-shortcuts"),
	openDiagnostics: element<HTMLButtonElement>("open-diagnostics"),
	deleteChats: element<HTMLButtonElement>("delete-chats"),
	deleteConfirm: element("delete-confirm"),
	confirmDelete: element<HTMLButtonElement>("confirm-delete"),
	cancelDelete: element<HTMLButtonElement>("cancel-delete"),
	deleteResult: element("delete-result"),
	closeSettings: element<HTMLButtonElement>("close-settings"),
	announcer: element("announcer"),
};

let state: PanelState | undefined;
/** The draft the composer text came from, and whether what it brought, its selection or its page, goes with the text. */
let composerDraft: Draft | undefined;
let quote = false;
/** A send waiting for its reply: composer text stays until the worker admitted it. */
let pendingSend = false;
let composerError: string | undefined;
const seenDrafts = new Set<string>();
/** The chats this panel removed from History: the tab leaving one keeps History open (`gestureArrived()`). */
const removedHere = new Set<number>();
let catalog: ModelInfo[] | undefined;
let catalogError: string | undefined;
/** Counts the catalog's invalidations: a load that started before the latest one keeps nothing. */
let catalogReads = 0;

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** The tab this panel belongs to: the worker opens it at `panel.html?tab=<id>`. */
const tabId = pageTab(location.search);
const client = new WorkerClient({
	tabId,
	log: false,
	onState: render,
	onConnection: renderConnection,
});

// Small DOM helpers. Text always goes in as text nodes.

const SVG = "http://www.w3.org/2000/svg";

function icon(name: string): SVGSVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("class", "icon");
	svg.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

function node<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const created = document.createElement(tag);
	if (className !== "") created.className = className;
	created.append(...children);
	return created;
}

/** A button that copies `text()`, and says for a moment whether it worked. */
function copyButton(button: HTMLButtonElement, text: () => string, label: string, title = label): HTMLButtonElement {
	const show = (status: "idle" | "copied" | "failed") => {
		const result = status === "idle" ? label : t(status === "copied" ? "copied" : "copyFailed");
		button.title = status === "idle" ? title : result;
		button.setAttribute("aria-label", result);
		button.querySelector("use")?.setAttribute("href", status === "copied" ? "#i-check" : "#i-copy");
		const textNode = [...button.childNodes].find((child) => child.nodeType === Node.TEXT_NODE);
		if (textNode !== undefined) textNode.textContent = result;
	};
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(text()).then(
			() => show("copied"),
			() => show("failed"),
		);
		setTimeout(() => show("idle"), 1500);
	});
	show("idle");
	return button;
}

/** OpenAI's "Manage usage" link, which its rules put next to each "Using ChatGPT plan" (design 6.20). */
function usageLink(): HTMLAnchorElement {
	const link = node("a", "", t("manageUsage"));
	link.href = CHATGPT.usageUrl;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	return link;
}

/** Puts `nodes` into `parent` in order. Nodes that stay are not moved, so a focused one keeps focus. */
function syncChildren(parent: HTMLElement, nodes: readonly Node[]): void {
	const keep = new Set(nodes);
	for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
	for (const [index, child] of nodes.entries()) {
		const at = parent.childNodes[index];
		if (at !== child) parent.insertBefore(child, at ?? null);
	}
}

/** A result line: green when `ok`, red when not, muted when null. Unchanged text is not set again, so it is not re-announced. */
function showResult(line: HTMLElement, text: string, ok: boolean | null): void {
	const className = ok === null ? "result" : ok ? "result ok" : "result bad";
	if (line.textContent === text && line.className === className) return;
	line.textContent = text;
	line.className = className;
}

/** Native radios drawn as segments: arrow keys, one tab stop, and the checked state come with them. */
function providerChoice(
	fieldset: HTMLElement,
	name: string,
	onChange: (provider: ProviderId) => void,
): Record<ProviderId, HTMLInputElement> {
	const radios: Partial<Record<ProviderId, HTMLInputElement>> = {};
	for (const provider of PROVIDER_IDS) {
		const radio = node("input", "");
		radio.type = "radio";
		radio.name = name;
		radio.value = provider;
		radio.addEventListener("change", () => onChange(provider));
		radios[provider] = radio;
		fieldset.append(node("label", "", radio, PROVIDERS[provider].name));
	}
	return radios as Record<ProviderId, HTMLInputElement>;
}

/** The chat's model: the open chat's own, or the default for the chat the next send starts. */
function chatModel(current: PanelState): ModelChoice {
	return current.chat.model ?? current.settings.model;
}

/** What the chat's provider lacks before anything can be sent, or null. */
function missing(current: PanelState): "key" | "permission" | null {
	const { key, permission } = current.status.access[chatModel(current).provider];
	return !key ? "key" : !permission ? "permission" : null;
}

// Connection: "Connecting..." in the header until the first snapshot; "Reconnecting..." only after a second down.

let connectedOnce = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function renderConnection(connection: Connection): void {
	clearTimeout(reconnectTimer);
	ui.incompatible.hidden = connection !== "incompatible";
	if (connection === "connected") {
		connectedOnce = true;
		ui.reconnecting.hidden = true;
	} else if (connection === "connecting" && connectedOnce) {
		reconnectTimer = setTimeout(() => {
			ui.reconnecting.hidden = false;
			announce(t("reconnecting"));
		}, 1000);
	}
}

function renderUsage(next: PanelState): void {
	const total = next.chat.usage === null ? "" : usageText(next.chat.usage);
	const window = catalogModel(chatModel(next))?.contextWindow;
	const context = contextText(next.chat.context, window);
	const text = [total, context].filter(Boolean).join(" ");
	ui.chatUsage.hidden = text === "";
	ui.chatUsage.textContent = text;
	ui.chatUsage.title = text === "" ? "" : usageHelp(next.chat.usage, { context: next.chat.context, window });
}

function render(next: PanelState): void {
	const previous = state;
	state = next;
	if (view !== "chat" && previous !== undefined && gestureArrived(previous, next)) showView("chat", false);
	const model = chatModel(next);
	renderModelChip(next);
	ui.planNote.hidden = !(model.provider === "openai" && next.status.access.openai.plan);
	ui.newChat.disabled = next.chat.conversationId === null;
	// Spend is cumulative; context usage describes only the current model context.
	renderUsage(next);
	ui.harnessError.hidden = next.status.harnessError === null;
	ui.harnessError.textContent = t("storageOpenFailed", [next.status.harnessError ?? ""]);
	ui.storageFull.hidden = !next.status.storageFull;
	ui.notice.hidden = next.notice === null;
	ui.noticeText.textContent = next.notice?.text ?? "";
	renderSetup(next);
	renderTranscript(next);
	renderDrafts(next);
	renderComposer();
	for (const row of keyRows) row.update(next);
	if (previous === undefined || settingsChanged(previous.settings, next.settings)) syncSettings(next.settings);
	// The "Current" tag follows the chat's model; the list, the providers with a key and the plan's models.
	if (
		previous !== undefined &&
		(!sameModel(chatModel(previous), model) ||
			JSON.stringify(previous.status.access) !== JSON.stringify(next.status.access))
	)
		renderModels();
	// A ChatGPT sign-in gives OpenAI's models its plan's context windows, an API key the API's: read the catalog again.
	if (previous !== undefined && previous.status.access.openai.plan !== next.status.access.openai.plan) {
		catalog = undefined;
		catalogReads += 1;
		void loadCatalog().then(() => renderModels());
	}
	if (previous !== undefined) announceChanges(previous, next);
	// The catalog says which models think, for the thinking picker; the model picker lists it.
	else
		void loadCatalog().then(() => {
			if (state !== undefined) renderModelChip(state);
			renderModels();
		});
}

/**
 * Whether something the user did elsewhere (a selection, a new chat) put new input into this tab's chat. The tab
 * leaving a chat this panel removed is not: History stays, with its Undo (design 6.30).
 */
function gestureArrived(previous: PanelState, next: PanelState): boolean {
	const lastInput = (current: PanelState) => current.chat.entries.findLast((entry) => entry.role === "user")?.id;
	const left = previous.chat.conversationId;
	const removed = left !== null && next.chat.conversationId === null && removedHere.has(left);
	return (
		next.sending > previous.sending ||
		(!removed &&
			(next.chat.conversationId !== left ||
				lastInput(next) !== lastInput(previous) ||
				next.chat.queued.some((item) => !previous.chat.queued.some((old) => old.id === item.id)))) ||
		next.drafts.some((draft) => !previous.drafts.some((old) => old.id === draft.id))
	);
}

// Screen readers hear changes, not every streamed batch.

function announce(text: string): void {
	ui.announcer.textContent = text;
}

function announceChanges(previous: PanelState, next: PanelState): void {
	if (next.chat.conversationId !== previous.chat.conversationId) return;
	if (!previous.chat.busy && next.chat.busy) announce(t("answering"));
	else if (previous.chat.busy && !next.chat.busy) {
		const entry = next.chat.entries.findLast((entry) => entry.role === "assistant");
		announce(
			entry?.stopped
				? t("answerStopped")
				: entry?.error == null
					? t("answerComplete")
					: t("answerFailed", [entry.error]),
		);
	} else if (next.chat.queued.length > previous.chat.queued.length) announce(t("queued"));
	const asked = next.asks.find((card) => !previous.asks.some((other) => other.id === card.id));
	if (asked !== undefined)
		announce(
			asked.kind === "site"
				? t("announceNeedsSite", [asked.origin === null ? t("movedSite") : originName(asked.origin)])
				: t(asked.kind === "script" ? "announceScript" : "announceAct", [asked.origin]),
		);
}

// Views: Settings and History replace the chat while open. The header stays.

type View = "chat" | "history" | "settings";
let view: View = "chat";

function showView(next: View, focus: boolean): void {
	if (next === view) return;
	view = next;
	ui.chatView.hidden = next !== "chat";
	ui.history.hidden = next !== "history";
	ui.settings.hidden = next !== "settings";
	ui.openHistory.setAttribute("aria-pressed", String(next === "history"));
	ui.openSettings.setAttribute("aria-pressed", String(next === "settings"));
	if (next === "chat") {
		// A hidden transcript measures 0, so the position is restored from the last user scroll.
		setScroll(pinned ? ui.transcript.scrollHeight : savedTop);
		renderJump();
		if (focus) ui.composer.focus();
	} else if (focus) {
		(next === "history" ? ui.closeHistory : ui.closeSettings).focus();
	}
	if (next === "settings") syncUserScripts();
}

// Keys: the setup card and Settings > API keys. The panel knows whether a key is saved and allowed, never the key.

type KeyForm = { node: HTMLElement; input: HTMLInputElement; show(provider: ProviderId): void; reset(): void };

/** A key field with Show/Hide, Save, what Chrome will ask, and "Get a key". Enter in the field saves too. */
function keyForm(save: () => void, ...extra: HTMLElement[]): KeyForm {
	const input = node("input", "");
	input.type = "password";
	input.autocomplete = "off";
	input.spellcheck = false;
	const reveal = node("button", "text-button reveal", t("show"));
	reveal.type = "button";
	reveal.addEventListener("click", () => {
		const shown = input.type === "password";
		input.type = shown ? "text" : "password";
		reveal.textContent = shown ? t("hide") : t("show");
		reveal.setAttribute("aria-label", shown ? t("hideKey") : t("showKey"));
	});
	reveal.setAttribute("aria-label", t("showKey"));
	const saveButton = node("button", "primary small-button", t("save"));
	saveButton.addEventListener("click", save);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.isComposing) return;
		event.preventDefault();
		save();
	});
	const why = node("span", "");
	const link = node("a", "", t("getKey"));
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	const form = node(
		"div",
		"key-form",
		node("div", "key-line", node("div", "key-field", input, reveal), saveButton, ...extra),
		node("p", "note", why, " ", link),
	);
	return {
		node: form,
		input,
		show(provider) {
			const { name, origin, keysUrl } = PROVIDERS[provider];
			input.placeholder = t("apiKey", [name]);
			input.setAttribute("aria-label", t("apiKey", [name]));
			why.textContent = t("keyPrivacy", [hostOf(origin)]);
			link.href = keysUrl;
		},
		reset() {
			input.value = "";
			input.type = "password";
			reveal.textContent = t("show");
			reveal.setAttribute("aria-label", t("showKey"));
		},
	};
}

/**
 * Saves a key once Chrome allowed pi to reach its provider. The prompt needs the click's user gesture, so it is
 * requested first, before any await. Saving never sends anything. A subscription token is refused before Chrome asks;
 * the worker refuses it too (design 6.19).
 */
function saveKey(provider: ProviderId, key: string): Promise<boolean> {
	if (subscriptionToken(provider, key)) return Promise.reject(new Error(t("subscriptionRefused")));
	return chrome.permissions.request({ origins: [PROVIDERS[provider].origin] }).then(async (granted) => {
		if (granted) await client.request({ type: "set-key", provider, key });
		return granted;
	});
}

function refusedText(provider: ProviderId): string {
	return t("keyRefused", [hostOf(PROVIDERS[provider].origin)]);
}

const NOT_ALLOWED = t("notAllowed");

/** Host access a ChatGPT sign-in needs for requests: the API, and the token endpoint for refreshes (design 6.20). */
const PLAN_ORIGINS = [PROVIDERS.openai.origin, CHATGPT.auth];

/**
 * Starts Sign in with ChatGPT in a tab next to this panel's: to the saved account, or with `another`, to a new one.
 * Chrome's prompt needs the click's user gesture, so it is requested first, before any await: the plan's origins, and
 * the loopback port whose callback the worker's rule catches (design 6.20).
 */
function signInChatGPT(another = false): Promise<string> {
	return chrome.permissions.request({ origins: [...PLAN_ORIGINS, CHATGPT.loopback] }).then(async (granted) => {
		if (!granted) return t("signInRefused");
		await client.request({ type: "chatgpt-sign-in", tabId, another });
		return SIGN_IN_STARTED;
	});
}

const SIGN_IN_STARTED = t("signInStarted");

/** What Allow access asks for: a ChatGPT sign-in's origins, or the provider's API. */
function accessOrigins(provider: ProviderId, current: PanelState | undefined): string[] {
	return provider === "openai" && current?.status.access.openai.plan ? PLAN_ORIGINS : [PROVIDERS[provider].origin];
}

// Setup: shown while the chat's provider has no key, or pi may not reach it.

/** The provider the setup card adds a key for: the chat's, until the user picks another. */
let setupChoice: ProviderId | undefined;
const setupRadios = providerChoice(ui.setupProviders, "setup-provider", (provider) => {
	setupChoice = provider;
	setupForm.show(provider);
	if (state !== undefined) renderSetup(state);
});
/** The setup card started a ChatGPT sign-in: once it is saved, the chat moves to OpenAI, as after a saved key. */
let setupSignIn = false;
const setupForm = keyForm(saveSetupKey);
ui.setupKey.append(setupForm.node);

function renderSetup(next: PanelState): void {
	const lack = missing(next);
	if (setupSignIn && next.status.access.openai.plan) {
		setupSignIn = false;
		// The worker made the plan's starting model the default when the default's provider had no credential.
		const { model } = next.settings;
		const modelId = model.provider === "openai" ? model.modelId : RECOMMENDED_MODELS.openai;
		if (lack !== null) {
			void useSavedProvider("openai", t("signedIn"), modelId).then((result) => {
				showResult(ui.setupResult, result.text, result.ok);
				announce(result.text);
			});
		}
	}
	ui.setup.hidden = lack === null;
	if (lack === null) {
		setupChoice = undefined;
		showResult(ui.setupResult, "", null);
		return;
	}
	const provider = chatModel(next).provider;
	ui.setupKey.hidden = lack !== "key";
	ui.setupAllow.hidden = lack !== "permission";
	ui.setupTitle.textContent = lack === "key" ? t("connectProvider") : t("allowProvider", [PROVIDERS[provider].name]);
	if (lack === "key" && setupChoice === undefined) {
		setupRadios[provider].checked = true;
		setupForm.show(provider);
	}
	ui.setupPlan.hidden = lack !== "key" || (setupChoice ?? provider) !== "openai";
	ui.setupAllowText.textContent = t(next.status.access[provider].plan ? "planSavedChrome" : "keySavedChrome");
}

ui.setupChatGPT.addEventListener("click", () => {
	signInChatGPT().then(
		(text) => {
			setupSignIn = text === SIGN_IN_STARTED;
			showResult(ui.setupResult, text, setupSignIn ? null : false);
		},
		(error: Error) => showResult(ui.setupResult, error.message, false),
	);
});

function saveSetupKey(): void {
	if (state === undefined) return;
	const provider = setupChoice ?? chatModel(state).provider;
	const key = setupForm.input.value.trim();
	if (key === "") {
		showResult(ui.setupResult, t("pasteKey"), false);
		return;
	}
	saveKey(provider, key).then(
		async (granted) => {
			if (!granted) return showResult(ui.setupResult, refusedText(provider), false);
			setupForm.reset();
			const result = await useSavedProvider(provider);
			showResult(ui.setupResult, result.text, result.ok);
			announce(result.text);
		},
		(error: Error) => showResult(ui.setupResult, error.message, false),
	);
}

/**
 * After setup saved a key for another provider than the chat's, the chat moves to that provider's recommended model,
 * so the card does not come back for the old one. Not while the chat is busy: the worker would refuse.
 */
async function useSavedProvider(
	provider: ProviderId,
	done = t("saved"),
	modelId = RECOMMENDED_MODELS[provider],
): Promise<{ text: string; ok: boolean }> {
	if (state === undefined || chatModel(state).provider === provider) return { text: `${done}.`, ok: true };
	const { chat } = state;
	if (chat.busy || chat.queued.length > 0)
		return { text: t("providerPickAfterSave", [done, PROVIDERS[provider].name]), ok: true };
	const model = { provider, modelId };
	try {
		await client.request({ type: "set-model", rev: state.rev, model });
		return { text: t("providerChangedAfterSave", [done, shortModel(model.modelId)]), ok: true };
	} catch (error) {
		return { text: t("providerUnchangedAfterSave", [done, (error as Error).message]), ok: false };
	}
}

ui.setupGrant.addEventListener("click", () => {
	if (state === undefined) return;
	// The worker sees the grant through `permissions.onAdded`; the card hides when the status says so.
	chrome.permissions.request({ origins: accessOrigins(chatModel(state).provider, state) }).then(
		(granted) => showResult(ui.setupResult, granted ? "" : NOT_ALLOWED, granted ? null : false),
		(error: Error) => showResult(ui.setupResult, error.message, false),
	);
});

// Settings > Providers: one row per provider. Remove asks first, since it cannot be undone.

const keyRows = PROVIDER_IDS.map(keyRow);
ui.keys.append(...keyRows.map((row) => row.node));
ui.planUsage.href = CHATGPT.usageUrl;

/**
 * `add()`: opens the row's key form, for a provider without a key. OpenAI's row also offers Sign in with ChatGPT, to
 * the saved account or another one; with a sign-in it shows "Using ChatGPT plan" and the account, Sign out in place
 * of Remove, and Sign in again once OpenAI ended the session (design 6.20).
 */
function keyRow(provider: ProviderId): { node: HTMLElement; update(next: PanelState): void; add(): void } {
	const { name } = PROVIDERS[provider];
	/**
	 * "ok", "denied" (saved, but no permission), or "none", marked "plan:" for a sign-in: a change clears a result that
	 * no longer holds.
	 */
	let access = "";
	let mode: "idle" | "confirm" | "add" = "idle";
	/** A button to focus once it shows: the one that replaced the button the user clicked. */
	let focusNext: HTMLButtonElement | undefined;
	/** Sign out's outcome, shown once the status has no sign-in: that change clears the result. */
	let signedOut: string | undefined;
	let waiting = false;

	/** Open: the row shows its actions and details under its head. A form or a confirmation opens it. */
	let open = false;
	const dot = node("span", "dot");
	const status = node("span", "status-text");
	const head = node("button", "key-toggle", dot, node("strong", "", name), status, icon("chevron"));
	head.setAttribute("aria-expanded", "false");
	const planLine = node("p", "muted", `${t("usingChatGPTPlan")} · `, usageLink());
	const account = node("p", "muted");
	const again = node("button", "small-button", t("signInAgain"));
	const verify = node("button", "small-button", t("verify"));
	const allow = node("button", "small-button", t("allowAccess"));
	const remove = node("button", "small-button", t("remove"));
	const add = node("button", "small-button", t("add"));
	const actions = node("div", "row", again, verify, allow, remove, add);
	const confirmText = node("span", "");
	const confirmNote = node("span", "");
	const confirmRemove = node("button", "small-button danger", t("remove"));
	const cancelRemove = node("button", "small-button", t("cancel"));
	const confirm = node(
		"div",
		"confirm",
		node("p", "", confirmText, " ", confirmNote),
		node("div", "row", confirmRemove, cancelRemove),
	);
	const cancelAdd = node("button", "small-button", t("cancel"));
	const form = keyForm(saveRowKey, cancelAdd);
	form.show(provider);
	const chatgpt = node("button", "small-button", t("continueChatGPT"));
	const another = node("button", "small-button", t("anotherAccount"));
	const cancelSignIn = node("button", "small-button", t("cancelSignIn"));
	const offer = node(
		"div",
		"plan-offer",
		node("p", "", node("strong", "", t("useChatGPTPlan")), node("br", ""), t("chatGPTPlanOffer")),
		node("div", "row", chatgpt, another, cancelSignIn),
	);
	const result = node("p", "result");
	result.setAttribute("role", "status");
	// Web search: its name and line on the left, Off and On on the right, as the tools in Settings.
	const searchTitle = node("span", "", t("webSearch"));
	searchTitle.id = `${provider}-web-search-title`;
	const searchRadios = (["off", "on"] as const).map((value) => {
		const radio = node("input", "");
		radio.type = "radio";
		radio.name = `${provider}-web-search`;
		radio.value = value;
		radio.addEventListener("change", () => saveSettings({ openaiWebSearch: value === "on" }, result));
		return radio;
	});
	const searchChoice = node(
		"fieldset",
		"segmented",
		...searchRadios.map((radio) => node("label", "", radio, t(radio.value === "on" ? "on" : "off"))),
	);
	searchChoice.setAttribute("aria-labelledby", searchTitle.id);
	const searchSetting = node(
		"div",
		"tool",
		node(
			"div",
			"setting",
			node("div", "tool-text", searchTitle, node("span", "note", t("webSearchNote"))),
			searchChoice,
		),
	);
	const body = node(
		"div",
		"key-body",
		...(provider === "openai" ? [planLine, account] : []),
		actions,
		confirm,
		form.node,
		...(provider === "openai" ? [offer, searchSetting] : []),
	);
	body.id = `key-body-${provider}`;
	head.setAttribute("aria-controls", body.id);
	const row = node("li", "", head, body, result);

	const setMode = (next: typeof mode, focus: HTMLElement) => {
		mode = next;
		if (next !== "idle") open = true;
		if (state !== undefined) update(state);
		focus.focus();
	};

	head.addEventListener("click", () => {
		const key = state?.status.access[provider].key === true;
		open = !open;
		if (!open) {
			if (mode === "add") form.reset();
			mode = "idle";
		} else if (!key && provider !== "openai") {
			// Nothing to do without a key but add one. OpenAI also offers the ChatGPT sign-in.
			setMode("add", form.input);
			return;
		}
		if (state !== undefined) update(state);
	});

	function update(next: PanelState): void {
		for (const radio of searchRadios) radio.checked = (radio.value === "on") === next.settings.openaiWebSearch;
		const { key, permission, plan } = next.status.access[provider];
		const now = `${plan ? "plan:" : ""}${!key ? "none" : permission ? "ok" : "denied"}`;
		const { chatgpt: signIn } = next.status;
		const nowWaiting = provider === "openai" && signIn.waiting;
		const ended = plan && signIn.ended;
		if (now !== access || (waiting && !nowWaiting)) {
			if (access === "none" && plan) announce(t("signedInChatGPT"));
			access = now;
			showResult(result, signedOut ?? "", signedOut === undefined ? null : false);
			if (!key) signedOut = undefined;
			if ((mode === "confirm" && !key) || (mode === "add" && key)) mode = "idle";
		}
		waiting = nowWaiting;
		const shown = providerStatus({ key, permission, plan, ended, waiting });
		status.textContent = shown.text;
		dot.className = `dot ${shown.tone}`;
		head.title = `${name}: ${shown.text}`;
		head.setAttribute("aria-expanded", String(open));
		body.hidden = !open;
		planLine.hidden = !plan;
		// The account stays saved after sign-out: Continue with ChatGPT signs in to it again.
		account.hidden = provider !== "openai" || signIn.account === null || (key && !plan);
		account.textContent = t("chatGPTAccount", [signIn.account?.email ?? t("savedAccount")]);
		again.hidden = !ended || waiting;
		verify.hidden = !key || !permission || ended;
		allow.hidden = !key || permission;
		remove.hidden = !key;
		remove.textContent = plan ? t("signOut") : t("remove");
		add.hidden = key;
		actions.hidden = mode !== "idle";
		confirm.hidden = mode !== "confirm";
		form.node.hidden = mode !== "add";
		offer.hidden = (key && !ended) || mode !== "idle" || (ended && !waiting);
		chatgpt.hidden = key;
		another.hidden = key || waiting || signIn.account === null;
		cancelSignIn.hidden = !waiting;
		confirmText.textContent = plan ? t("signOutQuestion") : t("removeKeyQuestion", [name]);
		confirmRemove.textContent = plan ? t("signOut") : t("remove");
		confirmNote.textContent =
			chatModel(next).provider !== provider ? "" : plan ? t("noSendUntilSignIn") : t("noSendUntilKey");
		if (focusNext !== undefined && !focusNext.hidden && !actions.hidden) {
			focusNext.focus();
			focusNext = undefined;
		}
	}

	function saveRowKey(): void {
		const key = form.input.value.trim();
		if (key === "") {
			showResult(result, t("pasteKey"), false);
			return;
		}
		saveKey(provider, key).then(
			(granted) => {
				if (!granted) return showResult(result, refusedText(provider), false);
				form.reset();
				mode = "idle";
				focusNext = verify;
				announce(t("keySaved", [name]));
				if (state !== undefined) update(state);
			},
			(error: Error) => showResult(result, error.message, false),
		);
	}

	verify.addEventListener("click", () => {
		verify.disabled = true;
		showResult(result, t("verifying"), null);
		client
			.request<{ result: string; status?: number }>({ type: "verify-key", provider })
			.then(
				(check) => {
					const shown = verifyText(check);
					showResult(result, shown.text, shown.ok);
				},
				(error: Error) => showResult(result, error.message, false),
			)
			.finally(() => {
				verify.disabled = false;
			});
	});
	allow.addEventListener("click", () => {
		chrome.permissions.request({ origins: accessOrigins(provider, state) }).then(
			(granted) => {
				if (!granted) return showResult(result, NOT_ALLOWED, false);
				focusNext = verify;
				if (state !== undefined) update(state);
			},
			(error: Error) => showResult(result, error.message, false),
		);
	});
	remove.addEventListener("click", () => setMode("confirm", cancelRemove));
	cancelRemove.addEventListener("click", () => setMode("idle", remove));
	confirmRemove.addEventListener("click", () => {
		const plan = state?.status.access[provider].plan === true;
		confirmRemove.disabled = true;
		const removed = plan
			? client.request<{ revoked: boolean }>({ type: "chatgpt-sign-out" }).then(({ revoked }) => {
					announce(t("signedOutChatGPT"));
					if (revoked) return;
					signedOut = t("signOutUnconfirmed");
					// The status may already have no sign-in: then no change shows it.
					if (state?.status.access[provider].key === false) {
						showResult(result, signedOut, false);
						signedOut = undefined;
					}
				})
			: client.request({ type: "set-key", provider, key: "" }).then(() => announce(t("keyRemoved", [name])));
		removed
			.then(
				() => {
					focusNext = add;
				},
				(error: Error) => showResult(result, error.message, false),
			)
			.finally(() => {
				confirmRemove.disabled = false;
				mode = "idle";
				if (state !== undefined) update(state);
			});
	});
	add.addEventListener("click", () => setMode("add", form.input));
	cancelAdd.addEventListener("click", () => {
		form.reset();
		if (provider !== "openai" && state?.status.access[provider].key !== true) {
			// The row had only the form to show.
			open = false;
			setMode("idle", head);
		} else setMode("idle", add);
	});
	for (const [button, other] of [
		[chatgpt, false],
		[again, false],
		[another, true],
	] as const) {
		button.addEventListener("click", () => {
			signInChatGPT(other).then(
				(text) => showResult(result, text, text === SIGN_IN_STARTED ? null : false),
				(error: Error) => showResult(result, error.message, false),
			);
		});
	}
	cancelSignIn.addEventListener("click", () => {
		client.request({ type: "chatgpt-cancel" }).then(
			() => chatgpt.focus(),
			(error: Error) => showResult(result, error.message, false),
		);
	});
	// Esc closes the confirmation or the form before it would leave Settings.
	row.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing || mode === "idle") return;
		event.preventDefault();
		const adding = mode === "add";
		if (adding) form.reset();
		if (adding && provider !== "openai" && state?.status.access[provider].key !== true) {
			open = false;
			setMode("idle", head);
		} else setMode("idle", adding ? add : remove);
	});

	return { node: row, update, add: () => setMode("add", form.input) };
}

// Transcript. An entry changes with its ID, but for the usage and stats its turn's end adds (`sameEntry`), so rendered
// nodes are kept, and drawn again from the first that changed. The tail (the empty state, the live answer, the queue,
// Retry) is kept by key too, so its buttons keep focus and the live dot keeps pulsing.

let renderedChat: number | null = null;
let rendered: ChatEntry[] = [];
const originBox = node("div", "");
const entriesBox = node("div", "entries");
const tailBox = node("div", "");
const stream = node("div", "stream", originBox, entriesBox, tailBox);
ui.transcript.append(stream);

// A link in an answer to a time in the tab's own page (`…&t=754s`) moves the tab's video there; the worker checks the
// page, and when it is another one, or has no media, the link opens in a new tab as any other (design 6.38).
ui.transcript.addEventListener("click", (event) => {
	const link = event.target instanceof Element ? event.target.closest(".md a[href]") : null;
	if (!(link instanceof HTMLAnchorElement) || tabId === null || linkTime(link.href) === null) return;
	if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	const open = () => void chrome.tabs.create({ url: link.href, openerTabId: tabId });
	client.request<boolean>({ type: "play-at", url: link.href }).then((played) => {
		if (!played) open();
	}, open);
});

/** Follow the end of the chat. Only the user's scrolling changes it; growing content and the composer do not. */
let pinned = true;
/** The scroll position the panel set last: a scroll event there is the panel's own. */
let ownTop = -1;
/** The position when the chat view was left. */
let savedTop = 0;
/** The user turned the wheel or pressed a scrolling key (Tab too: focus scrolls) since the panel's own scroll. */
let turned = false;
/** The user holds the scroll bar, or a selection, which scrolls past the chat's edge. */
let held = false;
/** The user touches the chat. A touch that pans cancels its pointer, so it is kept apart. */
let touching = false;

function setScroll(top: number): void {
	ui.transcript.scrollTop = top;
	ownTop = ui.transcript.scrollTop;
	turned = false;
}

ui.transcript.addEventListener("scroll", () => {
	if (view !== "chat") return;
	const { scrollTop, scrollHeight, clientHeight } = ui.transcript;
	savedTop = scrollTop;
	// The panel's own scroll, seen after the content grew again: not a reason to stop following.
	if (scrollTop === ownTop) return;
	ownTop = -1;
	const atEnd = scrollHeight - scrollTop - clientHeight < 24;
	if (atEnd || turned || held || touching) pinned = atEnd;
	// Not the user's: the box clamped it as the composer shrank, or kept an anchor in place, and the content may have
	// grown since. Keep following.
	else if (pinned) setScroll(scrollHeight);
	renderJump();
});

const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
ui.transcript.addEventListener(
	"wheel",
	() => {
		turned = true;
	},
	{ passive: true },
);
document.addEventListener("keydown", (event) => {
	const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
	// Tab moves focus also out of the message box, and the chat scrolls to show what got it.
	if (event.key === "Tab" || (!typing && scrollKeys.has(event.key))) turned = true;
});
ui.transcript.addEventListener("pointerdown", () => {
	held = true;
});
for (const type of ["pointerup", "pointercancel"])
	window.addEventListener(type, () => {
		held = false;
	});
ui.transcript.addEventListener(
	"touchstart",
	() => {
		touching = true;
	},
	{ passive: true },
);
for (const type of ["touchend", "touchcancel"])
	window.addEventListener(type, () => {
		touching = false;
	});

new ResizeObserver(() => {
	if (view === "chat" && pinned) setScroll(ui.transcript.scrollHeight);
}).observe(ui.transcript);
new ResizeObserver(() => {
	if (view === "chat" && pinned) setScroll(ui.transcript.scrollHeight);
}).observe(stream);

function renderJump(): void {
	ui.jump.hidden = pinned;
}

ui.jump.addEventListener("click", () => {
	pinned = true;
	setScroll(ui.transcript.scrollHeight);
	renderJump();
	ui.composer.focus();
});

function renderTranscript(next: PanelState): void {
	const { chat } = next;
	if (chat.conversationId !== renderedChat) {
		renderedChat = chat.conversationId;
		rendered = [];
		entriesBox.replaceChildren();
		editor = undefined;
		dropImages();
		diagrams.drop();
		pinned = true;
		renderJump();
	}
	let kept = 0;
	while (kept < rendered.length && kept < chat.entries.length && sameEntry(rendered[kept]!, chat.entries[kept]!))
		kept += 1;
	while (entriesBox.childNodes.length > kept) entriesBox.lastChild?.remove();
	for (const entry of chat.entries.slice(kept)) entriesBox.append(entryNode(entry));
	rendered = chat.entries;
	renderEditButtons(next);
	syncChildren(originBox, chat.editedFrom === null ? [] : [originNode(chat.editedFrom)]);

	const tail: HTMLElement[] = [];
	if (next.resumed !== null) {
		const text = resumedText(next.resumed, Date.now());
		if (resumedNode.textContent !== text) resumedNode.textContent = text;
		tail.push(resumedNode);
	}
	const empty = chat.entries.length === 0 && chat.live === null && chat.queued.length === 0 && next.sending === 0;
	if (empty && ui.setup.hidden) tail.push(emptyBox);
	if (chat.live !== null || chat.busy) tail.push(liveNode(next));
	else {
		live = undefined;
		clearInterval(progressTimer);
		progressTimer = undefined;
	}
	for (const [id] of askNodes) if (!next.asks.some((card) => card.id === id)) askNodes.delete(id);
	for (const card of next.asks) {
		let ask = askNodes.get(card.id);
		if (ask === undefined) {
			ask = askNode(card);
			askNodes.set(card.id, ask);
		}
		tail.push(ask);
	}
	for (const [id] of queuedNodes) {
		if (!chat.queued.some((item) => item.id === id)) queuedNodes.delete(id);
	}
	for (const item of chat.queued) {
		let queued = queuedNodes.get(item.id);
		if (queued === undefined) {
			queued = inputNode(item, item.mode);
			queuedNodes.set(item.id, queued);
		}
		tail.push(queued);
	}
	if (chat.retry !== null) tail.push(retryNode(chat.retry));
	if (next.sending > 0) tail.push(sendingNode);
	syncChildren(tailBox, tail);
}

function entryNode(entry: ChatEntry): HTMLElement {
	if (entry.role === "user") return turnNode(entry);
	if (entry.role === "notice") {
		// A step's line is cut at two lines, so it is whole in the tooltip.
		const text = node("span", entry.step ? "step-text" : "", entry.text);
		if (entry.step) text.title = entry.text;
		const notice = node("div", entry.step ? "msg notice step" : "msg notice", text);
		if (entry.detail !== null) notice.append(node("span", "detail", entry.detail));
		if (entry.error) notice.append(reasonNode(entry.error));
		if (entry.image) notice.append(shotNode(entry.id));
		return notice;
	}
	// What the model said before a tool call joins the step log; its answer comes later.
	const answer = node("div", entry.step ? "msg assistant step-note" : "msg assistant");
	if (entry.thinking !== null) answer.append(thinkingNode(entry.thinking).box);
	if (entry.text !== "") {
		const body = node("div", "md", renderAnswer(entry.text, document));
		addCodeCopy(body);
		addDiagrams(body);
		answer.append(body);
	}
	if (entry.error) answer.append(reasonNode(entry.error));
	const row = actions(entry);
	if (row !== null) answer.append(row);
	return answer;
}

// Screenshots: a tool's line with an image shows it small; a click shows it whole. The chat's state carries no images,
// so the panel asks for each once, as an object URL that lives until the panel shows another chat (design 6.26).

/** The object URL of each image in the chat shown, by its entry and its place among the entry's images (design 6.42). */
let images = new Map<string, Promise<string | null>>();

function imageUrl(entryId: number, index = 0): Promise<string | null> {
	const key = `${entryId}/${index}`;
	let url = images.get(key);
	if (url === undefined) {
		const chat = renderedChat;
		url = client
			.request<StoredImage | null>({ type: "get-image", entryId, index })
			.then((image) => (image === null || chat !== renderedChat ? null : objectUrl(image)))
			.catch(() => null);
		images.set(key, url);
	}
	return url;
}

function objectUrl(image: StoredImage): string {
	const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
	return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
}

function dropImages(): void {
	for (const url of images.values()) void url.then((found) => found !== null && URL.revokeObjectURL(found));
	images = new Map();
	if (ui.viewer.open) ui.viewer.close();
}

function shotNode(entryId: number, index = 0, label = t("screenshot")): HTMLElement {
	const image = node("img", "");
	image.alt = label;
	const button = node("button", "shot", image);
	button.title = t("showFullSize");
	button.hidden = true;
	void imageUrl(entryId, index).then((url) => {
		if (url === null) return button.remove();
		image.src = url;
		button.hidden = false;
	});
	button.addEventListener("click", () => showViewer(image.src, label));
	return button;
}

/** What an attachment's chip says: a file's name and length, an image's size and its encoded kilobytes. */
function attachmentLabel(info: AttachmentInfo): string {
	return info.kind === "file"
		? t("attachedFileChars", [info.name, info.chars.toLocaleString()])
		: t("attachedImageSize", [info.width, info.height, Math.max(1, Math.round((info.chars * 3) / 4 / 1024))]);
}

/**
 * An attachment as a chip: an image's thumbnail, which shows it full size, or a file's icon, then its label; with
 * `remove`, a button that removes it. `src`: the image's object URL, null while there is none. `name`: what the button
 * names, a file's name by default; an image sent keeps none.
 */
function attachmentChip(
	info: AttachmentInfo,
	src: Promise<string | null> | null,
	remove?: () => void,
	name = info.kind === "file" ? info.name : attachmentLabel(info),
): HTMLElement {
	const label = attachmentLabel(info);
	const chip = node("span", "attach attachment");
	chip.title = label;
	if (info.kind === "image" && src !== null) {
		const image = node("img", "");
		image.alt = "";
		const show = node("button", "thumb", image);
		show.hidden = true;
		show.setAttribute("aria-label", t("showImage", [label]));
		void src.then((url) => {
			if (url === null) return;
			image.src = url;
			show.hidden = false;
		});
		show.addEventListener("click", () => showViewer(image.src, label));
		chip.append(show);
	} else chip.append(icon("file"));
	chip.append(node("span", "", label));
	if (remove !== undefined) {
		const button = node("button", "icon-button small remove-attachment", icon("x"));
		button.title = t("removeAttachment", [name]);
		button.setAttribute("aria-label", t("removeAttachment", [name]));
		button.addEventListener("click", remove);
		chip.append(button);
	}
	return chip;
}

/**
 * The attachments of input `entryId`, under its text: images as screenshots are, files as chips. A queued input has no
 * entry yet, so its images show as chips without a thumbnail.
 */
function attachmentsNode(list: readonly AttachmentInfo[], entryId: number | null): HTMLElement {
	let image = 0;
	return node(
		"div",
		"attached",
		...list.map((info) =>
			info.kind === "image" && entryId !== null
				? shotNode(entryId, image++, attachmentLabel(info))
				: attachmentChip(info, null),
		),
	);
}

/** `src` full size, over the panel. */
function showViewer(src: string, label: string): void {
	ui.viewer.setAttribute("aria-label", label);
	ui.viewerImage.alt = t("viewerFullSize", [label]);
	ui.viewerImage.src = src;
	ui.viewer.showModal();
}

// A click anywhere closes it. Esc closes it here, so that the panel's Esc does not also stop the answer.
ui.viewer.addEventListener("click", () => ui.viewer.close());
ui.viewer.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.isComposing) return;
	event.preventDefault();
	ui.viewer.close();
});

function reasonNode(error: string): HTMLElement {
	const { text, usage } = answerError(error);
	const reason = node("span", "reason", text);
	if (usage) reason.append(" ", usageLink());
	return reason;
}

/**
 * A question: its text, or the preset and the quote of a selection sent unchanged, and the page it is about. `queued`:
 * how a queued input waits, null for a sent one.
 */
function inputNode(
	input: Omit<QueuedInput, "id" | "mode">,
	queued: WhenBusy | null,
	entryId: number | null = null,
): HTMLElement {
	const bubble = node("div", queued === null ? "msg user" : "msg user queued");
	if (queued !== null) bubble.append(node("span", "tag", t(queued === "steer" ? "queuedSteer" : "queuedFollowUp")));
	if (input.quote !== null)
		bubble.append(node("span", "preset", input.quote.preset), foldable(input.quote.text, "quote-text"));
	else if (input.text !== "" || input.attachments === undefined) bubble.append(foldable(input.text, "text"));
	if (input.attachments !== undefined) bubble.append(attachmentsNode(input.attachments, entryId));
	if (input.source !== null) bubble.append(sourceNode(input.source));
	if (input.moved !== undefined) bubble.append(movedNode(input.moved));
	return bubble;
}

/** Where the tab was when the message was sent, as the model was told (design 6.28). */
function movedNode(moved: PageMove): HTMLElement {
	if ("url" in moved) {
		const line = sourceNode(moved);
		line.firstChild?.after(node("span", "", t("tabMovedTo")));
		return line;
	}
	return node(
		"div",
		"source",
		icon("page"),
		moved.site === null ? t("tabMovedElsewhere") : t("tabMovedLastSeen", [originName(moved.site)]),
	);
}

// Edit (design 6.34): an input's text in a box in its place; Send makes a new chat from the chat up to it, with the
// new text, and the tab shows that chat. The chat edited stays in History.

/** The input being edited, one at a time. */
let editor: { entryId: number; close(): void } | undefined;
/** The entry whose edit waits for its reply. */
let editing: number | undefined;

/** A sent input: its bubble, and under it Copy and Edit. */
function turnNode(entry: ChatEntry): HTMLElement {
	const bubble = inputNode(entry, null, entry.id);
	const text = entry.sent ?? entry.text;
	const copy = copyButton(node("button", "icon-button small", icon("copy")), () => text, t("copyMessage"));
	const edit = node("button", "icon-button small edit-input", icon("edit"));
	edit.setAttribute("aria-label", t("editMessage"));
	const row = node("div", "actions turn-actions", copy, edit);
	const turn = node("div", "turn", bubble, row);
	edit.addEventListener("click", () => openEditor(entry, turn));
	return turn;
}

/** Edit waits while the chat runs or has queued inputs, as the worker requires, and for a key. */
function renderEditButtons(next: PanelState): void {
	const { chat } = next;
	const reason =
		chat.busy || chat.queued.length > 0 ? t("stopAnswerFirst") : !ui.setup.hidden ? t("addKeyFirst") : null;
	for (const button of entriesBox.querySelectorAll<HTMLButtonElement>(".edit-input")) {
		button.disabled = reason !== null || editing !== undefined;
		button.title = reason ?? t("editMessage");
	}
}

function openEditor(entry: ChatEntry, turn: HTMLElement): void {
	editor?.close();
	const box = node("textarea", "edit-box");
	box.value = entry.sent ?? entry.text;
	box.dir = "auto";
	box.setAttribute("aria-label", t("editMessage"));
	const later = state?.chat.entries.slice(state.chat.entries.findIndex((one) => one.id === entry.id) + 1) ?? [];
	const note = node("p", "edit-note", t("editNote"));
	if (later.some((one) => one.acted)) note.append(" ", t("editActedNote"));
	const cancel = node("button", "small-button", t("cancel"));
	const send = node("button", "small-button primary", t("send"));
	// The attachments that go with the edited message (design 6.42); ✕ leaves one out.
	const kept = new Set(entry.attachments?.map((_, index) => index));
	const files = node("div", "attached");
	const renderKept = () => {
		let image = 0;
		const chips = (entry.attachments ?? []).flatMap((info, index) => {
			const src = info.kind === "image" ? imageUrl(entry.id, image++) : null;
			if (!kept.has(index)) return [];
			return [
				attachmentChip(info, src, () => {
					kept.delete(index);
					renderKept();
					sync();
					box.focus();
				}),
			];
		});
		files.hidden = chips.length === 0;
		files.replaceChildren(...chips);
	};
	renderKept();
	const form = node("div", "msg user editor", box, files, note, node("div", "edit-row", cancel, send));
	const close = () => {
		form.remove();
		turn.classList.remove("editing");
		if (editor?.entryId === entry.id) editor = undefined;
	};
	editor = { entryId: entry.id, close };
	const submit = () => {
		const text = box.value.trim();
		const conversationId = state?.chat.conversationId;
		if (state === undefined || conversationId == null || (text === "" && kept.size === 0) || editing !== undefined)
			return;
		editing = entry.id;
		box.disabled = send.disabled = cancel.disabled = true;
		for (const button of files.querySelectorAll("button")) button.disabled = true;
		renderEditButtons(state);
		// A new request ID per Send, kept if the reply is lost, as for a send.
		client
			.request({
				type: "edit",
				rev: state.rev,
				conversationId,
				entryId: entry.id,
				text,
				keep: [...kept].sort((one, other) => one - other),
				requestId: crypto.randomUUID(),
			})
			.then(
				() => {
					close();
					ui.composer.focus();
				},
				(error: Error) => {
					box.disabled = send.disabled = cancel.disabled = false;
					for (const button of files.querySelectorAll("button")) button.disabled = false;
					showComposerError(error.message);
				},
			)
			.finally(() => {
				editing = undefined;
				if (state !== undefined) renderEditButtons(state);
			});
	};
	function sync(): void {
		send.disabled = (box.value.trim() === "" && kept.size === 0) || editing !== undefined;
	}
	box.addEventListener("input", sync);
	box.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "Escape") {
			// Handled: the panel's Esc does not also stop the answer.
			event.preventDefault();
			close();
			turn.querySelector<HTMLButtonElement>(".edit-input")?.focus();
		} else if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	});
	cancel.addEventListener("click", close);
	send.addEventListener("click", submit);
	sync();
	turn.classList.add("editing");
	turn.append(form);
	box.focus();
	box.setSelectionRange(box.value.length, box.value.length);
}

/** "Edited from an earlier chat. Open original", over a chat that Edit made. */
let origin: { from: number; node: HTMLElement } | undefined;
function originNode(from: number): HTMLElement {
	if (origin?.from !== from) {
		const open = node("button", "link", t("openOriginal"));
		open.addEventListener("click", () => {
			if (state === undefined) return;
			open.disabled = true;
			client
				.request({ type: "open-chat", rev: state.rev, target: from })
				.catch((error: Error) => showComposerError(error.message))
				.finally(() => {
					open.disabled = false;
				});
		});
		origin = { from, node: node("div", "msg notice origin", t("editedFrom"), " ", open) };
	}
	return origin.node;
}

/** Text that folds to 6 lines behind "Show more" when it is long. */
function foldable(text: string, className: string): DocumentFragment {
	const box = node("div", className, text);
	box.dir = "auto";
	const fragment = document.createDocumentFragment();
	fragment.append(box);
	if (!isLong(text)) return fragment;
	box.classList.add("clamp");
	const more = node("button", "more", t("showMore"));
	more.setAttribute("aria-expanded", "false");
	more.addEventListener("click", () => {
		const open = box.classList.toggle("clamp") === false;
		more.textContent = open ? t("showLess") : t("showMore");
		more.setAttribute("aria-expanded", String(open));
	});
	fragment.append(more);
	return fragment;
}

/** "Title · host", the host linked when the URL is a web link; the full URL in the tooltip. */
function sourceNode(source: { title: string; url: string }): HTMLElement {
	const line = node("div", "source", icon("page"));
	line.title = source.url;
	const host = hostOf(source.url);
	if (source.title !== "" && source.title !== host) line.append(node("span", "title", source.title), "·");
	const href = safeHref(source.url);
	if (href === undefined) {
		line.append(node("span", "", host));
	} else {
		const link = node("a", "", host);
		link.href = href;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		line.append(link);
	}
	return line;
}

/** A Copy button on each code block of a committed answer; the live answer is rebuilt too often to keep one. */
function addCodeCopy(body: HTMLElement): void {
	for (const pre of body.querySelectorAll("pre")) {
		const wrap = node("div", "code");
		pre.replaceWith(wrap);
		const button = node("button", "icon-button small", icon("copy"));
		wrap.append(
			pre,
			copyButton(button, () => pre.textContent ?? "", t("copyCode")),
		);
	}
}

// Diagrams (design 6.32): a closed ```mermaid fence shows as code until its picture is ready, then as the picture, with
// the code folded under "Source". A cached picture replaces the code before the next paint, so a streaming answer, which
// is drawn again on every update, does not flicker.

const diagrams = new Diagrams(() => new Worker("diagram-worker.js", { type: "module" }));
/** The source each diagram picture shows, to draw it again in the other theme. */
const diagramSources = new WeakMap<HTMLImageElement, string>();

/** The panel's theme colors, as the pictures' colors. */
function diagramColors(): DiagramColors {
	const style = getComputedStyle(document.documentElement);
	const color = (name: string) => style.getPropertyValue(name).trim();
	return {
		bg: color("--code-bg"),
		fg: color("--fg"),
		line: color("--muted"),
		accent: color("--accent"),
		muted: color("--muted"),
		surface: color("--bg"),
		surfaceAlt: color("--panel-hover"),
		border: color("--border"),
	};
}

function addDiagrams(body: HTMLElement): void {
	const colors = diagramColors();
	for (const pre of [...body.querySelectorAll("pre.mermaid")].slice(0, MAX_DIAGRAMS)) {
		const source = pre.textContent ?? "";
		void diagrams.url(source, colors).then((url) => {
			if (url === null || !pre.isConnected) return;
			// The code with its Copy button, if it has one.
			showDiagram(pre.parentElement?.classList.contains("code") ? pre.parentElement : pre, source, url);
		});
	}
}

/** Puts the picture in place of `code`, and `code` under its "Source". */
function showDiagram(code: Element, source: string, url: string): void {
	const image = node("img", "");
	image.src = url;
	image.alt = t("diagram");
	diagramSources.set(image, source);
	const open = node("button", "diagram-open", image);
	open.type = "button";
	open.title = t("showFullSize");
	// Asked again, not `image.src`: the cache may have let the picture go and revoked its URL; then it is drawn again.
	open.addEventListener("click", () => {
		void diagrams.url(source, diagramColors()).then((fresh) => {
			if (fresh !== null) image.src = fresh;
			showViewer(fresh ?? image.src, t("diagram"));
		});
	});
	const details = node("details", "diagram-source", node("summary", "", t("diagramSource")));
	code.replaceWith(node("div", "diagram", open, details));
	details.append(code);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const colors = diagramColors();
	for (const image of document.querySelectorAll<HTMLImageElement>(".diagram img")) {
		const source = diagramSources.get(image);
		if (source !== undefined)
			void diagrams.url(source, colors).then((url) => {
				if (url !== null) image.src = url;
			});
	}
});

/** What the model thought before it answered, folded under "Thinking". */
function thinkingNode(text: string): { box: HTMLDetailsElement; text: HTMLElement } {
	const shown = node("div", "thinking-text", text);
	shown.dir = "auto";
	return { box: node("details", "thinking", node("summary", "", t("thinking")), shown), text: shown };
}

/**
 * Copy, for an answer with text that is not a step, and the answer's time and tools, also for one with only thinking
 * or an error, or a step that ended its turn (design 6.21). Its tooltip adds the tools by name, the tokens, and the
 * cost; without a time or a tool, an info icon holds it. The chat's total shows above the message box. Null when there
 * is neither.
 */
function actions(entry: ChatEntry): HTMLElement | null {
	const help = answerHelp(entry.usage, entry.stats);
	if (entry.text === "" && help === "") return null;
	const copy = entry.text !== "" && !entry.step;
	const row = node("div", copy ? "actions" : "actions usage-only");
	if (copy)
		row.append(
			copyButton(
				node("button", "text-button", icon("copy"), t("copy")),
				() => entry.text,
				t("copy"),
				t("copyMarkdown"),
			),
		);
	if (help !== "") {
		const line = answerLine(entry.stats);
		const hint = line === "" ? node("span", "usage-hint", icon("info")) : node("span", "answer-stats", line);
		hint.title = help;
		// Focusable, so the keyboard reaches what the pointer gets on hover; a screen reader reads the label.
		hint.tabIndex = 0;
		hint.setAttribute("role", "img");
		hint.setAttribute("aria-label", t("answerUsage", [help.replace(/\n+/g, "; ")]));
		row.append(hint);
	}
	return row;
}

/**
 * The answer in progress: its header node stays, so the dot keeps pulsing; its body follows the text. The thinking
 * stays too, so it stays open once opened.
 */
let live:
	| {
			node: HTMLElement;
			label: HTMLElement;
			thinking: { box: HTMLDetailsElement; text: HTMLElement };
			body: HTMLElement;
			text: string | undefined;
			/** "Answering", "Thinking", or a retry, before the progress. */
			status: string;
	  }
	| undefined;
/** Counts the live answer's seconds while it shows. */
let progressTimer: ReturnType<typeof setInterval> | undefined;

/** The live answer's line: what it does, then its time and tools so far, "Answering · 4s · 1 tool". */
function showProgress(): void {
	if (live === undefined) return;
	const progress = state?.chat.progress ?? null;
	const label = progress === null ? live.status : `${live.status} · ${progressLine(progress, Date.now())}`;
	if (live.label.textContent !== label) live.label.textContent = label;
}

function liveNode(next: PanelState): HTMLElement {
	if (live === undefined) {
		const label = node("span", "");
		const thinking = thinkingNode("");
		thinking.box.hidden = true;
		const body = node("div", "md");
		const created = node(
			"div",
			"msg live",
			node("div", "live-head", node("span", "pulse"), label),
			thinking.box,
			body,
		);
		created.setAttribute("aria-busy", "true");
		live = { node: created, label, thinking, body, text: undefined, status: "" };
		progressTimer ??= setInterval(showProgress, 1000);
	}
	const current = next.chat.live;
	const doing = current !== null && current.text === "" && current.thinking !== "" ? t("thinking") : t("answering");
	const label =
		current === null
			? t("working")
			: current.retry
				? t("retrying", [current.retry])
				: current.attempt > 1
					? t("answerAttempt", [doing, current.attempt])
					: doing;
	live.status = label;
	showProgress();
	const thought = current?.thinking ?? "";
	if (live.thinking.text.textContent !== thought) {
		live.thinking.text.textContent = thought;
		live.thinking.box.hidden = thought === "";
	}
	const text = current?.text ?? "";
	if (live.text !== text) {
		live.text = text;
		live.body.replaceChildren(renderAnswer(text, document));
		addDiagrams(live.body);
	}
	return live.node;
}

const queuedNodes = new Map<number, HTMLElement>();
/** The Ask cards shown, by ID: a card keeps its node, and the focus on its buttons, across batches. */
const askNodes = new Map<string, HTMLElement>();

/**
 * May pi use the card's site in this answer (design 6.28), act on it, or run this script there (6.23)? A button answers
 * it; the card then goes. A script's summary is the model's words; the code is what runs.
 */
function askNode(card: AskCard): HTMLElement {
	const result = node("span", "result");
	result.setAttribute("role", "status");
	const buttons: HTMLButtonElement[] = [];
	const fail = (message: string) => {
		for (const button of buttons) button.disabled = false;
		showResult(result, message, false);
	};
	/** `request`: the Chrome access a site card's button asks for first (design 6.28). */
	const answer = (reply: AskReply, request: string | null = null) => {
		for (const button of buttons) button.disabled = true;
		// Inside the click: Chrome asks only during a user gesture.
		const granted = request === null ? Promise.resolve(true) : chrome.permissions.request({ origins: [request] });
		granted.then(
			(yes) =>
				yes
					? client.request({ type: "answer-ask", askId: card.id, answer: reply }).then(
							() => {},
							(error: Error) => fail(error.message),
						)
					: fail(t("chromeDenied")),
			(error: Error) => fail(error.message),
		);
	};
	const button = (label: string, reply: AskReply, primary = false, request: string | null = null) => {
		const made = node("button", primary ? "primary small-button" : "small-button", label);
		made.addEventListener("click", () => answer(reply, request));
		buttons.push(made);
		return made;
	};
	let question: HTMLElement[];
	/** A script card's second row: Run that also covers the site's next scripts. */
	let later: HTMLElement | null = null;
	if (card.kind === "script") {
		const site = hostOf(card.origin);
		button(t("run"), "allow", true);
		button(t("deny"), "deny");
		const forAnswer = button(t("runForAnswer"), "answer");
		forAnswer.title = t("runForAnswerTip", [site]);
		const forChat = button(t("runForChat"), "chat");
		forChat.title = t("runForChatTip", [site]);
		later = node("div", "row later", node("span", "", t("runNextScripts")), forAnswer, forChat);
		question = [
			node(
				"p",
				"",
				t("runScriptQuestion", [site]),
				...(card.summary === null ? [] : [node("span", "", t("piSays", [card.summary]))]),
			),
			node("pre", "", card.code),
			node("p", "", node("span", "", t("scriptAskWarning", [site]))),
		];
	} else if (card.kind === "act") {
		button(t("allow"), "allow", true);
		button(t("deny"), "deny");
		question = [node("p", "", t("actQuestion", [card.origin]), node("span", "", t("actWarning")))];
	} else {
		// One of Chrome's grants; Settings > Advanced > Sites lists and removes it.
		const pattern = card.origin === null ? null : sitePattern(card.origin);
		const name = pattern === null ? null : siteName(pattern);
		button(t("onAllSites"), "allow", true, "<all_urls>");
		if (pattern !== null) button(t("onSite", [name ?? ""]), "allow", false, pattern);
		button(t("cancel"), "deny");
		question = [
			node(
				"p",
				"",
				name === null ? t("needsMovedSite") : t("needsSite", [name]),
				node("span", "", t("siteAskNote")),
				// Chrome does not tell pi the site: the toolbar button lets pi in on it alone (design 6.28).
				...(name === null ? [node("span", "", t("movedSiteHint"))] : []),
			),
		];
	}
	const first = later === null ? buttons : buttons.filter((one) => one.parentElement !== later);
	const box = node(
		"div",
		"ask",
		...question,
		node("div", "row", ...first, result),
		...(later === null ? [] : [later]),
	);
	box.setAttribute("role", "group");
	box.setAttribute("aria-label", t("piAsks"));
	return box;
}
const sendingNode = node("div", "msg notice", t("sending"));
/** "Continued a chat started 2 days ago": the tab found this chat by its page, until the tab's next send. */
const resumedNode = node("div", "msg notice", "");

/** The entry of a Retry waiting for its reply; its button stays disabled across renders. */
let retrying: number | undefined;
let retryRow: { entryId: number; node: HTMLElement; button: HTMLButtonElement } | undefined;

function retryNode(entryId: number): HTMLElement {
	if (retryRow?.entryId !== entryId) {
		const button = node("button", "small-button", t("retry"));
		button.addEventListener("click", () => {
			const conversationId = state?.chat.conversationId;
			if (state === undefined || conversationId == null) return;
			retrying = entryId;
			button.disabled = true;
			// A new request ID: Retry is a new submission. It is minted at the click and kept if the reply is lost.
			client
				.request({ type: "retry", rev: state.rev, conversationId, entryId, requestId: crypto.randomUUID() })
				.catch((error: Error) => showComposerError(error.message))
				.finally(() => {
					retrying = undefined;
					if (state !== undefined) renderTranscript(state);
				});
		});
		retryRow = { entryId, node: node("div", "retry", node("span", "", t("noCompleteAnswer")), button), button };
	}
	// Without a key, Retry would fail the same way: setup comes first.
	const setup = !ui.setup.hidden;
	retryRow.button.disabled = retrying === entryId || setup;
	retryRow.button.title = setup ? t("addKeyFirst") : "";
	return retryRow.node;
}

// The empty chat: how to ask, and with a page attached, a question to send in one click. One node, updated in
// place, so a focused suggestion keeps focus across batches.

const emptyTitle = node("h3", "", "");
const emptyType = node("p", "");
const suggestions = node(
	"div",
	"suggestions",
	suggestion(
		t("summarizePage"),
		"Summarize the whole page in a few sentences, then list its key points as short bullets.",
	),
);
const emptyBox = node("div", "empty", emptyTitle, emptyType, suggestions);

function suggestion(label: string, text: string): HTMLButtonElement {
	const button = node("button", "suggestion", label);
	button.addEventListener("click", () => {
		if (state === undefined) return;
		const language = effectiveAnswerLanguage(state.settings.language);
		sendText(text + ANSWER.replace("{{language}}", () => language), {
			draft: undefined,
			quote: false,
			page: attachedPage(),
			fromComposer: false,
			whenBusy: state.settings.enterWhileBusy,
			attachments: [],
		});
	});
	return button;
}

/** Called on every render and on every composer change: the suggestions must not replace what the user typed. */
function updateEmpty(): void {
	const page = attachedPage();
	const title = page !== null ? t("askPage") : t("menuAsk");
	if (emptyTitle.textContent !== title) emptyTitle.textContent = title;
	const type = page !== null ? t("askPageHint") : t("askHint");
	if (emptyType.textContent !== type) emptyType.textContent = type;
	suggestions.hidden = !(
		state !== undefined &&
		ui.setup.hidden &&
		page !== null &&
		ui.composer.value.trim() === "" &&
		attachments.length === 0 &&
		composerDraft === undefined &&
		!pendingSend &&
		!state.chat.busy
	);
}

// Drafts: text not sent yet, one compact row each. A new one fills an empty composer. Past 2, the older ones fold
// behind a toggle above the newest 2, which sit next to the composer. "Add to message" text is never listed: it goes
// into the composer.

const draftRows = new Map<string, { node: HTMLElement; edit: HTMLButtonElement }>();
let draftsOpen = false;
const draftsToggle = node("button", "more drafts-toggle", "");
draftsToggle.addEventListener("click", () => {
	draftsOpen = !draftsOpen;
	if (state !== undefined) renderDrafts(state);
});

function renderDrafts(next: PanelState): void {
	for (const draft of next.drafts) {
		if (seenDrafts.has(draft.id)) continue;
		if (draft.insert) {
			// The composer is read-only while a send waits; the text goes in when it is done (`sendText()`).
			if (pendingSend) continue;
			seenDrafts.add(draft.id);
			addToComposer(draft.text);
			void client.request({ type: "discard-draft", draftId: draft.id }).catch(() => {});
			continue;
		}
		seenDrafts.add(draft.id);
		// The box is empty only without attachments too: a draft would join an image to text it was not sent with.
		if (ui.composer.value.trim() === "" && attachments.length === 0 && !pendingSend) loadDraft(draft);
	}
	// While its text is in the message box, a draft that is no longer stored (the ten-draft limit dropped it) keeps its
	// page or its selection, and never takes the tab's newer page (design 6.18).
	if (
		composerDraft !== undefined &&
		ui.composer.value.trim() === "" &&
		!next.drafts.some((draft) => draft.id === composerDraft?.id)
	) {
		composerDraft = undefined;
		quote = false;
	}
	const listed = next.drafts.filter((draft) => draft.id !== composerDraft?.id && !draft.insert);
	for (const id of draftRows.keys()) {
		if (!listed.some((draft) => draft.id === id)) draftRows.delete(id);
	}
	const rows = listed.map((draft) => {
		let row = draftRows.get(draft.id);
		if (row === undefined) {
			row = draftRow(draft);
			draftRows.set(draft.id, row);
		}
		return row;
	});
	// Edit replaces the composer text, so it waits until text that is not this draft's, and any attachment, is sent or
	// cleared: else a draft's text and page would go with attachments it was not sent with.
	const typed =
		(ui.composer.value.trim() !== "" && ui.composer.value !== composerDraft?.text) || attachments.length > 0;
	for (const row of rows) {
		row.edit.disabled = typed || pendingSend;
		row.edit.title = typed ? t("clearComposerFirst") : t("putInComposer");
	}
	const older = rows.slice(0, -2).map((row) => row.node);
	const newest = rows.slice(-2).map((row) => row.node);
	if (older.length === 0) draftsOpen = false;
	draftsToggle.textContent = draftsOpen
		? t("showFewer")
		: t(older.length === 1 ? "moreDraft" : "moreDrafts", [older.length]);
	draftsToggle.setAttribute("aria-expanded", String(draftsOpen));
	const nodes = older.length === 0 ? newest : [...(draftsOpen ? older : []), draftsToggle, ...newest];
	syncChildren(ui.drafts, nodes);
}

function draftRow(draft: Draft): { node: HTMLElement; edit: HTMLButtonElement } {
	const what = node("span", draft.note === null ? "muted" : "error");
	what.textContent = draft.note === null ? t("notSent") : t("notSentReason", [draft.note]);
	const preview = node("span", "", draft.text.replace(/\s+/g, " ").trim());
	preview.dir = "auto";
	const edit = node("button", "small-button", t("edit"));
	edit.addEventListener("click", () => loadDraft(draft));
	const discard = node("button", "icon-button small", icon("x"));
	discard.title = t("discardDraft");
	discard.setAttribute("aria-label", t("discardDraft"));
	discard.addEventListener("click", () => {
		void client.request({ type: "discard-draft", draftId: draft.id }).catch(() => {});
	});
	return { node: node("div", "draft", node("div", "", what, preview), edit, discard), edit };
}

/**
 * "Add to message": the selected text goes after what the message box holds, with a blank line before the cursor, so
 * the user writes the question around it. Several selections collect in one message.
 */
function addToComposer(text: string): void {
	const before = ui.composer.value.trimEnd();
	// Blank lines around the selection go; the indent of its first line stays.
	const added = text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
	ui.composer.value = `${before === "" ? "" : `${before}\n\n`}${added}\n\n`;
	composerError = undefined;
	ui.composer.focus();
	ui.composer.setSelectionRange(ui.composer.value.length, ui.composer.value.length);
	// The list was for the message before: a completion now would replace what was added.
	renderSlash();
	renderComposer();
	ui.composer.scrollTop = ui.composer.scrollHeight;
	announce(t("addedToMessage"));
}

function loadDraft(draft: Draft): void {
	if (pendingSend || attachments.length > 0) return;
	composerDraft = draft;
	quote = draft.selection !== null || draft.page !== null;
	composerError = undefined;
	ui.composer.value = draft.text;
	ui.composer.focus();
	if (state !== undefined) renderDrafts(state);
	renderSlash();
	renderComposer();
}

// Attachments (design 6.42): the images and text files in the message box. Like its text, they stay until a send
// takes them. Each file is prepared in turn, one at a time; Send waits until all are ready.

type ComposerAttachment =
	| { id: number; name: string; ready: false }
	| {
			id: number;
			name: string;
			ready: true;
			attachment: MessageAttachment;
			info: AttachmentInfo;
			preview: string | null;
	  };

let attachments: ComposerAttachment[] = [];
let attachmentIds = 0;
/** The files being prepared, in turn. */
let preparing: Promise<void> = Promise.resolve();

/**
 * Files from the picker, a paste, or a drop. Those that do not fit the ten are not read; the others that fail are
 * dropped. One error line, after the batch, gives every reason, each naming its file.
 */
function addFiles(files: readonly File[]): void {
	if (files.length === 0 || pendingSend) return;
	const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
	const errors = files.length > room ? [t("attachTooMany", [MAX_ATTACHMENTS])] : [];
	const taken = files.slice(0, room).map((file) => ({ file, id: ++attachmentIds }));
	for (const { file, id } of taken) attachments.push({ id, name: file.name, ready: false });
	composerError = undefined;
	renderAttachments();
	const batch = taken.map(({ file, id }) => {
		preparing = preparing
			.then(async () => {
				// Removed while it waited: not read at all.
				if (!attachments.some((each) => each.id === id)) return;
				landAttachment(id, await prepare(file));
			})
			.catch((error: Error) => {
				removeAttachment(id);
				errors.push(error.message);
			});
		return preparing;
	});
	void Promise.all(batch).then(() => {
		if (errors.length > 0) showComposerError(errors.join(" "));
	});
}

/** A prepared file into its place in the list, unless it was removed meanwhile; throws what keeps it out. */
function landAttachment(id: number, attachment: MessageAttachment): void {
	const at = attachments.findIndex((each) => each.id === id);
	const name = attachments[at]?.name;
	if (name === undefined) return;
	const [info] = attached([attachment]).infos;
	if (info === undefined) return;
	if (info.kind === "file") {
		// The files' characters in all, as the worker checks them at Send.
		const chars = attachments.reduce(
			(sum, each) => sum + (each.ready && each.info.kind === "file" ? each.info.chars : 0),
			0,
		);
		if (chars + info.chars > MAX_FILES_CHARS)
			throw new Error(t("attachFilesTooLong", [MAX_FILES_CHARS.toLocaleString()]));
	}
	const preview = attachment.kind === "image" ? objectUrl(attachment.image) : null;
	attachments[at] = { id, name, ready: true, attachment, info, preview };
	renderAttachments();
}

function removeAttachment(id: number): void {
	const removed = attachments.find((each) => each.id === id);
	if (removed === undefined) return;
	if (removed.ready && removed.preview !== null) URL.revokeObjectURL(removed.preview);
	attachments = attachments.filter((each) => each !== removed);
	renderAttachments();
}

/** After a send took them. */
function clearAttachments(): void {
	for (const each of attachments) if (each.ready && each.preview !== null) URL.revokeObjectURL(each.preview);
	attachments = [];
	renderAttachments();
}

function renderAttachments(): void {
	ui.attachments.hidden = attachments.length === 0;
	ui.attachments.replaceChildren(
		...attachments.map((each) => {
			const remove = () => {
				removeAttachment(each.id);
				ui.composer.focus();
			};
			if (each.ready) return attachmentChip(each.info, Promise.resolve(each.preview), remove, each.name);
			const chip = attachmentChip({ kind: "file", name: each.name, chars: 0 }, null, remove, each.name);
			chip.classList.add("preparing");
			chip.title = t("attachPreparing", [each.name]);
			chip.querySelector(":scope > span")?.replaceChildren(t("attachPreparing", [each.name]));
			return chip;
		}),
	);
	renderComposer();
	// The drafts' Edit waits while the box holds attachments.
	if (state !== undefined) renderDrafts(state);
}

ui.attach.addEventListener("click", () => ui.attachInput.click());
ui.attachInput.addEventListener("change", () => {
	addFiles([...(ui.attachInput.files ?? [])]);
	ui.attachInput.value = "";
	ui.composer.focus();
});
// Text first: a copy from a page or an office app carries both its text and an image of it, and the text is what the
// user meant. A paste of images alone attaches them. Decided here, in the event: the clipboard is gone after it.
ui.composer.addEventListener("paste", (event) => {
	const data = event.clipboardData;
	if (data === null || data.getData("text/plain") !== "" || data.files.length === 0) return;
	event.preventDefault();
	addFiles([...data.files]);
});
// A file dropped anywhere on the panel goes into the message box. Handled for the whole page: else Chrome opens the
// file in the panel in place of pi.
document.addEventListener("dragover", (event) => {
	if (event.dataTransfer?.types.includes("Files") !== true) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = view === "chat" && !pendingSend ? "copy" : "none";
});
document.addEventListener("drop", (event) => {
	if (event.dataTransfer?.types.includes("Files") !== true) return;
	event.preventDefault();
	if (view === "chat") addFiles([...event.dataTransfer.files]);
});

// Composer.

/** When the user chose not to attach the tab's page; a newer gesture attaches again. */
let detached: number | undefined;

function attachedPage(): AttachedPage | null {
	return choosePage(state?.page ?? null, detached, quote ? (composerDraft ?? null) : null);
}

/** Grows the message box with its text, up to its CSS max-height. Setting `value` fires no input event. */
function fitComposer(): void {
	ui.composer.style.height = "auto";
	ui.composer.style.height = `${ui.composer.scrollHeight}px`;
}

// A narrower panel wraps the text, or the placeholder, onto more lines: fit the box again. Only on a change of width,
// which fitting does not make. In the next frame: resizing the box inside the callback leaves its own and the chat's
// notifications for the same frame undelivered, and Chrome reports that as an error of the extension.
let composerWidth = 0;
let fitting = 0;
new ResizeObserver(([change]) => {
	const width = change?.contentRect.width ?? 0;
	if (width === composerWidth) return;
	composerWidth = width;
	cancelAnimationFrame(fitting);
	fitting = requestAnimationFrame(fitComposer);
}).observe(ui.composer);

function renderComposer(): void {
	const chat = state?.chat;
	const selection = quote ? (composerDraft?.selection ?? null) : null;
	ui.quote.hidden = selection === null;
	ui.quoteText.textContent =
		selection === null ? "" : `${selection.preset} · ${selection.page.title || hostOf(selection.page.url)}`;
	ui.quote.title = selection === null ? "" : selection.page.url;
	const page = attachedPage();
	ui.page.hidden = page === null;
	ui.pageText.textContent = page === null ? "" : page.title || hostOf(page.url);
	const pattern = page === null ? null : sitePattern(page.url);
	if (pattern !== (site?.pattern ?? null)) void checkSite(pattern);
	const allowed = site !== undefined && site.allowed === true;
	ui.page.title = page === null ? "" : allowed ? t("pageReadTip", [page.url, siteName(site!.pattern)]) : page.url;
	ui.allowSite.hidden = site === undefined || site.allowed !== false;
	if (site !== undefined) {
		const label = t("alwaysAllowSite", [siteName(site.pattern)]);
		ui.allowSite.setAttribute("aria-label", label);
		ui.allowSite.title = t("alwaysAllowSiteTip", [label]);
	}
	ui.chips.hidden = ui.quote.hidden && ui.page.hidden;
	ui.composer.placeholder = page !== null || selection !== null ? t("askPage") : t("menuAsk");
	ui.stop.hidden = chat?.busy !== true;
	const hasText = ui.composer.value.trim() !== "" || attachments.length > 0;
	const setup = state === undefined ? null : missing(state);
	ui.send.disabled =
		!hasText || attachments.some((each) => !each.ready) || pendingSend || state === undefined || setup !== null;
	ui.composer.readOnly = pendingSend;
	ui.attach.disabled = pendingSend || attachments.length >= MAX_ATTACHMENTS;
	for (const button of ui.attachments.querySelectorAll("button")) button.disabled = pendingSend;
	const status = composerStatus({
		error: composerError,
		note: composerDraft?.note ?? null,
		sending: pendingSend,
		setup,
		busy: chat?.busy === true,
		hasText,
		enter: state?.settings.enterWhileBusy ?? "steer",
	});
	ui.composerStatus.hidden = status.text === "";
	// A hint of two, "Enter joins the task · Alt+Enter sends after the answer", is wider than the line beside Stop at
	// 400 px: each part stays whole, and the second takes a line of its own when both do not fit.
	const parts = status.tone === "plain" ? status.text.split(" · ") : [status.text];
	// The space between them keeps the text one sentence for a screen reader; the flex line ignores it.
	ui.composerStatus.replaceChildren(
		...parts.flatMap((part, index) =>
			index < parts.length - 1
				? [node("span", "status-part", `${part} ·`), " "]
				: [node("span", "status-part", part)],
		),
	);
	ui.composerStatus.className = status.tone === "bad" ? "status bad" : parts.length > 1 ? "status parts" : "status";
	ui.composerStatus.title = status.text;
	fitComposer();
	updateEmpty();
}

function showComposerError(text: string): void {
	composerError = text;
	renderComposer();
}

/** `other`: Alt+Enter, which sends a message while pi works the other way than Enter does (design 6.39). */
function send(other = false): void {
	const draft = composerDraft;
	const quoted = quote && draft?.selection != null;
	const page = attachedPage();
	let text = ui.composer.value.trim();
	// A quoted selection's text is its prompt already, as is a page prompt's draft sent unchanged: a slash there is text.
	const filled = quoted || (draft?.prompt != null && text === draft.text.trim());
	if (!filled && state !== undefined) {
		const language = effectiveAnswerLanguage(state.settings.language);
		const expanded = expandCommand(text, slashCommands(state.settings.prompts, language), language, page);
		if (expanded?.kind === "needs-text") {
			showComposerError(t("slashNeedsText", [expanded.name]));
			return;
		}
		if (expanded !== null) text = expanded.text;
	}
	closeSlash();
	const enter = state?.settings.enterWhileBusy ?? "steer";
	const whenBusy = other ? (enter === "steer" ? "followUp" : "steer") : enter;
	if (attachments.some((each) => !each.ready)) return;
	const files = attachments.flatMap((each) => (each.ready ? [each.attachment] : []));
	sendText(text, { draft, quote: quoted, page, fromComposer: true, whenBusy, attachments: files });
}

// Slash commands (design 6.33): while the message is "/" and the start of a prompt's name, a list of the prompts
// under it; arrows move, Enter or Tab completes the name, Esc closes the list until the message changes.

let slashOptions: SlashCommand[] = [];
let slashActive = 0;
/** The message the list was closed for with Esc. */
let slashDismissed: string | undefined;

function renderSlash(): void {
	const message = ui.composer.value;
	if (slashDismissed !== message) slashDismissed = undefined;
	const language = state === undefined ? undefined : effectiveAnswerLanguage(state.settings.language);
	const options =
		language === undefined || slashDismissed !== undefined || (quote && composerDraft?.selection != null)
			? []
			: matchingCommands(message, slashCommands(state!.settings.prompts, language));
	if (options.map((each) => each.command).join("\n") !== slashOptions.map((each) => each.command).join("\n"))
		slashActive = 0;
	slashOptions = options;
	ui.slashMenu.hidden = options.length === 0;
	ui.slashMenu.replaceChildren(
		...options.map((each, index) => {
			const option = node(
				"div",
				"option",
				node("div", "line", node("span", "name", `/${each.command}`), node("span", "id", each.name)),
			);
			option.id = `slash-${index}`;
			option.setAttribute("role", "option");
			option.setAttribute("aria-selected", String(index === slashActive));
			// Keeps the focus in the message box.
			option.addEventListener("pointerdown", (event) => event.preventDefault());
			option.addEventListener("click", () => completeSlash(index));
			return option;
		}),
	);
	if (options.length > 0) {
		ui.composer.setAttribute("aria-activedescendant", `slash-${slashActive}`);
		ui.slashMenu.children[slashActive]?.scrollIntoView({ block: "nearest" });
	} else ui.composer.removeAttribute("aria-activedescendant");
}

/** "/name " in the message box: Enter then runs it for the page, or the text typed after it fills the selection. */
function completeSlash(index: number): void {
	const chosen = slashOptions[index];
	if (chosen === undefined) return;
	ui.composer.value = `/${chosen.command} `;
	ui.composer.setSelectionRange(ui.composer.value.length, ui.composer.value.length);
	composerError = undefined;
	renderSlash();
	renderComposer();
	ui.composer.focus();
}

function closeSlash(): void {
	slashOptions = [];
	ui.slashMenu.hidden = true;
	ui.composer.removeAttribute("aria-activedescendant");
}

/** Sends a typed message. Only a send from the composer clears it: a suggestion leaves what the user typed. */
function sendText(
	text: string,
	options: {
		draft: Draft | undefined;
		quote: boolean;
		page: AttachedPage | null;
		fromComposer: boolean;
		whenBusy: WhenBusy;
		/** Taken when Send is: a resend after a lost reply carries the same ones (design 6.42). */
		attachments: MessageAttachment[];
	},
): void {
	if (
		(text === "" && options.attachments.length === 0) ||
		pendingSend ||
		state === undefined ||
		missing(state) !== null
	)
		return;
	pendingSend = true;
	composerError = undefined;
	renderComposer();
	client
		.request({
			type: "send",
			rev: state.rev,
			conversationId: state.chat.conversationId,
			requestId: crypto.randomUUID(),
			text,
			draftId: options.draft?.id ?? null,
			quote: options.quote,
			page: options.page,
			whenBusy: options.whenBusy,
			attachments: options.attachments,
		})
		.then(() => {
			if (options.fromComposer) {
				ui.composer.value = "";
				composerDraft = undefined;
				quote = false;
				clearAttachments();
			}
			// The user's own question: show it, also when they had scrolled up.
			pinned = true;
			setScroll(ui.transcript.scrollHeight);
			renderJump();
		})
		.catch((error: Error) => {
			composerError = error.message;
		})
		.finally(() => {
			pendingSend = false;
			renderComposer();
			if (state !== undefined) renderDrafts(state);
			ui.composer.focus();
		});
}

function abort(): void {
	if (state === undefined || !state.chat.busy) return;
	client.request({ type: "abort", rev: state.rev }).catch((error: Error) => showComposerError(error.message));
}

ui.send.addEventListener("click", (event) => send(event.altKey));
ui.stop.addEventListener("click", abort);
ui.composer.setAttribute("aria-autocomplete", "list");
ui.composer.setAttribute("aria-controls", "slash-menu");
ui.composer.addEventListener("keydown", (event) => {
	if (slashOptions.length > 0 && !event.isComposing) {
		const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		if (move !== 0) {
			event.preventDefault();
			slashActive = (slashActive + move + slashOptions.length) % slashOptions.length;
			renderSlash();
			return;
		}
		if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
			event.preventDefault();
			completeSlash(slashActive);
			return;
		}
		if (event.key === "Escape") {
			// Handled: the panel's Esc does not also stop the answer.
			event.preventDefault();
			slashDismissed = ui.composer.value;
			closeSlash();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		send(event.altKey);
	}
});
ui.composer.addEventListener("input", () => {
	composerError = undefined;
	renderSlash();
	// Drafts first: emptying the box can release a draft that is no longer stored, and the chips must follow.
	if (state !== undefined) renderDrafts(state);
	renderComposer();
});
// Esc closes the model picker, or goes back from a view: there it must not stop an answer the user cannot see. Filters
// and inline forms handle it before, and mark it handled. A select's open list, as the thinking levels' that Chrome
// draws in the page, closes itself on Esc and does not mark it.
document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
	if (document.querySelector("select:open") !== null) return;
	if (!ui.modelPopup.hidden) closeModels(true);
	else if (view !== "chat") showView("chat", true);
	else abort();
});
ui.removeQuote.addEventListener("click", () => {
	quote = false;
	// Plain text: the tab's page, which may be another one, is not attached either.
	detached = Date.now();
	renderComposer();
	ui.composer.focus();
});
// "Always allow" (design 6.22): the attached page's site, and whether pi may read it without a click; `allowed` is
// undefined until Chrome answers.
let site: { pattern: string; allowed: boolean | undefined } | undefined;

async function checkSite(pattern: string | null): Promise<void> {
	site = pattern === null ? undefined : { pattern, allowed: undefined };
	if (pattern === null) return;
	const allowed = await chrome.permissions.contains({ origins: [pattern] }).catch(() => undefined);
	if (site?.pattern !== pattern) return;
	site = { pattern, allowed };
	renderComposer();
}

ui.allowSite.addEventListener("click", () => {
	const pattern = site?.pattern;
	if (pattern === undefined) return;
	// Inside the click: Chrome asks only during a user gesture.
	chrome.permissions.request({ origins: [pattern] }).then(
		(granted) => {
			if (!granted) return;
			announce(t("readSiteNoClick", [siteName(pattern)]));
			ui.composer.focus();
		},
		() => {},
	);
});

// Grants change here, in Chrome's settings, or in another panel.
const sitesChanged = () => {
	site = undefined;
	renderComposer();
	void renderSites();
};
chrome.permissions.onAdded.addListener(sitesChanged);
chrome.permissions.onRemoved.addListener(sitesChanged);

ui.detachPage.addEventListener("click", () => {
	// A page prompt's draft goes as plain text: its own page, and the tab's, stay off.
	quote = false;
	detached = Date.now();
	renderComposer();
	ui.composer.focus();
});

ui.newChat.addEventListener("click", () => {
	if (state === undefined) return;
	showView("chat", false);
	client
		.request({
			type: "new-chat",
			rev: state.rev,
			// Refreshing metadata is not a new attach gesture. Keep an explicit Don't attach choice in effect.
			attachPage: detached === undefined || (state.page !== null && state.page.capturedAt > detached),
		})
		.catch((error: Error) => showComposerError(t("newChatFailed", [error.message])));
});

/** A filter field: Esc with text clears it instead of leaving the view. */
function filterField(input: HTMLInputElement, onChange: () => void): void {
	input.addEventListener("input", onChange);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing || input.value === "") return;
		event.preventDefault();
		input.value = "";
		onChange();
	});
}

// History: the running chats, then the others under Today, Yesterday, Previous 7 days, and Earlier, newest first.

const HISTORY_LABELS = {
	Today: "today",
	Yesterday: "yesterday",
	"Previous 7 days": "previousDays",
	Earlier: "earlier",
} as const;
let historyChats: ChatSummary[] = [];
/** Read once per load, so every row's time is relative to the same moment. */
let historyNow = 0;

async function openHistory(): Promise<void> {
	showView("history", true);
	ui.historyFilter.value = "";
	historyChats = [];
	ui.historyNote.hidden = false;
	ui.historyNote.textContent = t("loading");
	ui.historyList.replaceChildren();
	try {
		historyChats = await client.request<ChatSummary[]>({ type: "list-chats" });
		historyNow = Date.now();
		renderHistory();
	} catch (error) {
		ui.historyNote.textContent = (error as Error).message;
	}
}

function renderHistory(): void {
	const words = ui.historyFilter.value.trim().toLowerCase();
	const shown = historyChats.filter(
		(chat) =>
			words === "" ||
			[chat.title, chat.page?.title ?? "", chat.page === null ? "" : pageAddress(chat.page.url)].some((text) =>
				text.toLowerCase().includes(words),
			),
	);
	ui.historyNote.hidden = true;
	const running = shown.filter((chat) => chat.running);
	const empty =
		words !== "" && shown.length === 0
			? t("noChatsMatch")
			: words === "" && !historyChats.some((chat) => !chat.active)
				? t("noEarlierChats")
				: "";
	ui.historyList.replaceChildren(
		...(running.length === 0
			? []
			: [node("h3", "", t("running")), node("ul", "history", ...running.map(historyItem))]),
		...groupChats(
			shown.filter((chat) => !chat.running),
			historyNow,
		).flatMap(({ group, chats }) => [
			node("h3", "", t(HISTORY_LABELS[group])),
			node("ul", "history", ...chats.map(historyItem)),
		]),
		...(empty === "" ? [] : [node("p", "muted none", empty)]),
	);
}

function historyItem(chat: ChatSummary): HTMLElement {
	const title = node("span", "title", chat.title);
	title.dir = "auto";
	const label = node("span", "label", title);
	// An edited chat starts like the chat it was made from, so it has its title too.
	if (chat.edited) title.prepend(node("span", "pill", t("editedChat")), " ");
	if (chat.page !== null) {
		// The page the chat is about, so two chats with the same question tell apart; whole in the tooltip.
		const address = node("span", "address", pageAddress(chat.page.url));
		address.title = chat.page.title === "" ? chat.page.url : `${chat.page.title}\n${chat.page.url}`;
		label.append(address);
	}
	const started = new Date(chat.createdAt);
	let when: HTMLElement;
	if (chat.active) {
		when = node("span", "pill accent", t("current"));
	} else {
		const time = node("time", "", historyTime(chat.createdAt, historyNow));
		time.dateTime = started.toISOString();
		time.title = t("started", [started.toLocaleString(interfaceLocale())]);
		when = time;
	}
	const button = node("button", "history-row", label, when);
	if (chat.active) button.setAttribute("aria-current", "true");
	button.addEventListener("click", () => {
		if (state === undefined) return;
		if (chat.active) return showView("chat", true);
		button.disabled = true;
		client.request({ type: "open-chat", rev: state.rev, target: chat.id, createdAt: chat.createdAt }).then(
			() => showView("chat", true),
			(error: Error) => {
				button.disabled = false;
				historyMessage(error.message);
			},
		);
	});
	const item = node("li", "history-item", button);
	item.append(...chatMenu(chat, item, button));
	return item;
}

/** A line over the list: what an action did or why it failed, with an optional button, such as Undo. */
let historyTimer: ReturnType<typeof setTimeout> | undefined;
function historyMessage(text: string, action?: { label: string; run: () => void }): void {
	clearTimeout(historyTimer);
	ui.historyNote.hidden = false;
	ui.historyNote.replaceChildren(text);
	if (action !== undefined) {
		const undo = node("button", "link", action.label);
		undo.addEventListener("click", () => {
			clearTimeout(historyTimer);
			ui.historyNote.hidden = true;
			action.run();
		});
		ui.historyNote.append(" ", undo);
		historyTimer = setTimeout(() => {
			ui.historyNote.hidden = true;
		}, 8000);
	}
}

/** History again, as it is now, keeping the filter. */
async function reloadHistory(): Promise<void> {
	historyChats = await client.request<ChatSummary[]>({ type: "list-chats" });
	historyNow = Date.now();
	renderHistory();
}

/** The open menu of a History row, if any: one at a time. */
let openMenu: { menu: HTMLElement; trigger: HTMLButtonElement } | undefined;
function closeMenu(focus: boolean): void {
	if (openMenu === undefined) return;
	openMenu.menu.hidden = true;
	openMenu.trigger.setAttribute("aria-expanded", "false");
	if (focus) openMenu.trigger.focus();
	openMenu = undefined;
}
document.addEventListener("pointerdown", (event) => {
	if (openMenu !== undefined && !(event.target instanceof Node && openMenu.menu.parentElement?.contains(event.target)))
		closeMenu(false);
});

/** A History row's ⋯ menu: Rename, Export as Markdown, Remove from History (design 6.30). */
function chatMenu(chat: ChatSummary, item: HTMLElement, row: HTMLButtonElement): HTMLElement[] {
	const trigger = node("button", "icon-button small chat-more", icon("more"));
	trigger.setAttribute("aria-label", t("moreForChat", [chat.title]));
	trigger.title = t("more");
	trigger.setAttribute("aria-haspopup", "menu");
	trigger.setAttribute("aria-expanded", "false");
	const action = (label: string, run: () => void) => {
		const made = node("button", "", label);
		made.setAttribute("role", "menuitem");
		made.addEventListener("click", () => {
			closeMenu(false);
			run();
		});
		return made;
	};
	const remove = action(t("removeFromHistory"), () => removeChat(chat));
	if (chat.running) {
		remove.disabled = true;
		remove.title = t("stopAnswerFirst");
	}
	const items = [
		action(t("rename"), () => renameChat(chat, item, row)),
		action(t("exportMarkdown"), () => exportChat(chat)),
		remove,
	];
	const menu = node("div", "menu", ...items);
	menu.setAttribute("role", "menu");
	menu.hidden = true;
	trigger.addEventListener("click", () => {
		const open = openMenu?.menu === menu;
		closeMenu(false);
		if (open) return;
		menu.hidden = false;
		trigger.setAttribute("aria-expanded", "true");
		openMenu = { menu, trigger };
		items[0]!.focus();
	});
	menu.addEventListener("keydown", (event) => {
		const enabled = items.filter((one) => !one.disabled);
		const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === "Escape") {
			event.preventDefault();
			closeMenu(true);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = (at + (event.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length;
			enabled[next]?.focus();
		}
	});
	return [trigger, menu];
}

/** The row's title becomes a field: Enter saves, Esc or leaving it cancels; an empty title brings back the automatic one. */
function renameChat(chat: ChatSummary, item: HTMLElement, row: HTMLButtonElement): void {
	const input = node("input", "rename");
	input.type = "text";
	input.value = chat.title;
	input.maxLength = MAX_CHAT_TITLE;
	input.setAttribute("aria-label", t("chatTitle"));
	row.hidden = true;
	item.prepend(input);
	input.focus();
	input.select();
	let done = false;
	const finish = () => {
		done = true;
		input.remove();
		row.hidden = false;
	};
	input.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			finish();
			row.focus();
		} else if (event.key === "Enter") {
			event.preventDefault();
			const title = input.value;
			input.disabled = true;
			client.request({ type: "rename-chat", target: chat.id, createdAt: chat.createdAt, title }).then(
				() => reloadHistory().catch(() => {}),
				(error: Error) => {
					finish();
					historyMessage(t("notRenamed", [error.message]));
				},
			);
		}
	});
	input.addEventListener("blur", () => {
		if (!done && !input.disabled) finish();
	});
}

/** Downloads the chat as a Markdown file named after its title. */
function exportChat(chat: ChatSummary): void {
	client.request<ChatExport>({ type: "export-chat", target: chat.id, createdAt: chat.createdAt }).then(
		({ title, markdown }) => {
			const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
			const link = node("a", "");
			link.href = url;
			link.download = `${fileName(title)}.md`;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			announce(t("exported"));
		},
		(error: Error) => historyMessage(t("notExported", [error.message])),
	);
}

/** Removes the chat from History, with Undo for a few seconds. */
function removeChat(chat: ChatSummary): void {
	// Before the request: the tab's new state can arrive before its reply.
	removedHere.add(chat.id);
	client.request({ type: "remove-chat", target: chat.id, createdAt: chat.createdAt }).then(
		() => {
			historyChats = historyChats.filter((one) => one.id !== chat.id);
			renderHistory();
			historyMessage(t("removedChat", [chat.title]), {
				label: t("undo"),
				run: () => {
					client
						.request({ type: "restore-chat", target: chat.id, createdAt: chat.createdAt })
						.then(() => {
							removedHere.delete(chat.id);
							return reloadHistory();
						})
						.catch((error: Error) => historyMessage(t("notRestored", [error.message])));
				},
			});
			announce(t("removedFromHistory"));
		},
		(error: Error) => {
			removedHere.delete(chat.id);
			historyMessage(t("notRemoved", [error.message]));
		},
	);
}

filterField(ui.historyFilter, renderHistory);
ui.openHistory.addEventListener("click", () => {
	if (view === "history") showView("chat", true);
	else void openHistory();
});
ui.closeHistory.addEventListener("click", () => showView("chat", true));

ui.dismissNotice.addEventListener("click", () => {
	const notice = state?.notice;
	if (notice != null) void client.request({ type: "dismiss-notice", noticeId: notice.id }).catch(() => {});
});

ui.reloadPage.addEventListener("click", () => location.reload());

// The model picker: the chip in the message box opens a filter and one list box of the models of every provider with a
// key, under the provider's name (design 6.19). Arrow keys move the selection, past the names; a click or Enter
// switches the chat to it and closes the picker.

let selectedModel: ModelChoice | undefined;
let shownModels: ModelInfo[] = [];
let modelOptions: HTMLElement[] = [];
let markedIndex = -1;
/** The last failed switch. It stays until the selection changes, not until the next batch. */
let modelMessage: string | undefined;
let modelPending = false;

function openSettings(): void {
	if (state === undefined) return;
	closeModels(false);
	showView("settings", true);
	syncSettings(state.settings);
	void renderSites();
	void renderShortcuts();
}

function openModels(): void {
	if (state === undefined || !ui.modelPopup.hidden) return;
	ui.modelPopup.hidden = false;
	ui.model.setAttribute("aria-expanded", "true");
	ui.modelFilter.value = "";
	selectedModel = chatModel(state);
	modelMessage = undefined;
	renderModels();
	markSelected("center");
	ui.modelFilter.focus();
	if (catalog === undefined)
		void loadCatalog().then(() => {
			renderModels();
			markSelected("center");
		});
}

/** `focus`: back to the chip, when the picker had focus and nothing else takes it. */
function closeModels(focus: boolean): void {
	if (ui.modelPopup.hidden) return;
	ui.modelPopup.hidden = true;
	ui.model.setAttribute("aria-expanded", "false");
	if (focus) ui.model.focus();
}

async function loadCatalog(): Promise<void> {
	const reads = catalogReads;
	try {
		const loaded = catalog ?? (await client.request<ModelInfo[]>({ type: "list-models" }));
		// A catalog read before the sign-in changed has the other windows.
		if (reads !== catalogReads) return;
		catalog = loaded;
		if (state !== undefined) renderUsage(state);
		catalogError = undefined;
	} catch (error) {
		catalogError = t("loadModelsFailed", [(error as Error).message]);
	}
}

/** The chat's model in the catalog, once it loaded. */
function catalogModel(choice: ModelChoice): ModelInfo | undefined {
	return catalog?.find((model) => sameModel({ provider: model.provider, modelId: model.id }, choice));
}

/** The chip shows the chat's model and its provider; it is disabled while the worker would refuse a change. */
function renderModelChip(next: PanelState): void {
	const model = chatModel(next);
	const provider = PROVIDERS[model.provider].name;
	const known = catalogModel(model);
	const name = known === undefined ? shortModel(model.modelId) : modelName(known);
	ui.modelName.textContent = name;
	ui.modelProvider.textContent = provider;
	const busy = next.chat.busy || next.chat.queued.length > 0;
	ui.model.disabled = busy;
	ui.model.title = busy ? t("modelBusyTip", [provider, model.modelId]) : `${provider}: ${model.modelId}`;
	ui.model.setAttribute("aria-label", t("modelAria", [name, provider]));
	// The chip is disabled now, so focus in the picker goes to the message box.
	if (busy && !ui.modelPopup.hidden) {
		const focused = ui.modelPopup.contains(document.activeElement);
		closeModels(false);
		if (focused) ui.composer.focus();
	}
	const thinking = thinkingPicker(known, next.settings.thinking);
	ui.thinking.disabled = !thinking.enabled;
	ui.thinkingPicker.title = thinking.title;
	ui.thinkingPicker.classList.toggle("off", !thinking.enabled);
	for (const option of ui.thinking.options) {
		if (!isThinking(option.value)) continue;
		// The saved level stays selectable, so the picker keeps showing it on a model that lacks it.
		option.disabled = !thinking.levels[option.value].enabled && option.value !== next.settings.thinking;
		option.title = thinking.levels[option.value].title;
	}
}

/**
 * The models of the providers with a key, grouped under each provider's name in `PROVIDERS` order, and a line that
 * names the providers without one. The selected model stays selected while it is listed.
 */
function renderModels(): void {
	if (state === undefined || ui.modelPopup.hidden) return;
	const current = chatModel(state);
	const { access } = state.status;
	const keyed = new Set(PROVIDER_IDS.filter((provider) => access[provider].key));
	const found = filterModels(offeredModels(catalog ?? [], access), keyed, ui.modelFilter.value);
	// In the order shown, so the arrow keys follow the list.
	shownModels = PROVIDER_IDS.flatMap((provider) => found.filter((model) => model.provider === provider));
	modelOptions = shownModels.map((model, index) => modelOption(model, index, current));
	markedIndex = -1;
	const groups = PROVIDER_IDS.flatMap((provider) => {
		const options = modelOptions.filter((_, index) => shownModels[index]?.provider === provider);
		if (options.length === 0) return [];
		// Without the "Manage usage" link: a listbox holds options only. Settings and the composer have it.
		const plan = provider === "openai" && access.openai.plan;
		const name = node("div", "group-name", PROVIDERS[provider].name, plan ? ` · ${t("usingChatGPTPlan")}` : "");
		name.id = `model-group-${provider}`;
		name.setAttribute("role", "presentation");
		const group = node("div", "group", name, ...options);
		group.setAttribute("role", "group");
		group.setAttribute("aria-labelledby", name.id);
		return [group];
	});
	const none =
		catalogError ??
		(catalog === undefined ? t("loadingModels") : keyed.size === 0 ? t("addKeyListModels") : t("noModelsMatch"));
	ui.modelList.replaceChildren(...(groups.length > 0 ? groups : [node("div", "none", none)]));
	const keyless = PROVIDER_IDS.filter((provider) => !access[provider].key);
	ui.modelMissing.hidden = keyed.size === 0 || keyless.length === 0;
	ui.modelMissing.replaceChildren(
		t("noKeyPrefix"),
		...keyless.flatMap((provider, index) => {
			const add = node("button", "link", PROVIDERS[provider].name);
			add.addEventListener("click", () => {
				openSettings();
				keyRows[PROVIDER_IDS.indexOf(provider)]?.add();
			});
			return index === 0 ? [add] : [", ", add];
		}),
		t("inSettingsSuffix"),
	);
	markSelected(null);
	renderModelResult();
}

/**
 * Line 1: the name and its tags; line 2: `provider/model`. Option IDs use the index: model IDs hold "/", "~", and
 * ":".
 */
function modelOption(model: ModelInfo, index: number, current: ModelChoice): HTMLElement {
	const tags = modelTags(model, current).map((tag) =>
		node("span", tag === "current" ? "pill accent" : "pill", t(tag)),
	);
	const path = `${model.provider}/${model.id}`;
	const option = node(
		"div",
		"option",
		node("div", "line", node("span", "name", modelName(model)), ...tags),
		node("div", "id", path),
	);
	option.id = `model-${index}`;
	option.setAttribute("role", "option");
	option.setAttribute("aria-selected", "false");
	option.title = path;
	option.addEventListener("click", () => {
		selectModel(index, null);
		pickModel();
	});
	return option;
}

function selectedIndex(): number {
	const selected = selectedModel;
	if (selected === undefined) return -1;
	return shownModels.findIndex((model) => sameModel({ provider: model.provider, modelId: model.id }, selected));
}

function selectModel(index: number, block: "center" | "nearest" | null): void {
	const model = shownModels[index];
	if (model === undefined) return;
	selectedModel = { provider: model.provider, modelId: model.id };
	modelMessage = undefined;
	markSelected(block);
	renderModelResult();
}

function markSelected(block: "center" | "nearest" | null): void {
	const index = selectedIndex();
	modelOptions[markedIndex]?.setAttribute("aria-selected", "false");
	markedIndex = index;
	const option = modelOptions[index];
	if (option === undefined) {
		ui.modelList.removeAttribute("aria-activedescendant");
		return;
	}
	option.setAttribute("aria-selected", "true");
	ui.modelList.setAttribute("aria-activedescendant", option.id);
	// By hand: `scrollIntoView()` would scroll the chat too.
	const list = ui.modelList;
	// A provider's first model brings the provider's name into view with it.
	const name = option.previousElementSibling;
	const top = name instanceof HTMLElement && name.classList.contains("group-name") ? name.offsetTop : option.offsetTop;
	if (block === "center") list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
	else if (block === "nearest" && top < list.scrollTop) list.scrollTop = top;
	else if (block === "nearest" && option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
		list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
}

/** The picker's line: the last failed switch, or "Switching...". */
function renderModelResult(): void {
	showResult(
		ui.modelResult,
		modelPending ? t("switching") : (modelMessage ?? ""),
		modelMessage === undefined ? null : false,
	);
}

/** Switches the chat to the selected model. The worker can still refuse: another panel may have started an answer. */
function pickModel(): void {
	const model = shownModels[selectedIndex()];
	if (state === undefined || model === undefined || modelPending) return;
	const choice = { provider: model.provider, modelId: model.id };
	const { chat } = state;
	const use = useModelState({
		selected: choice,
		current: chatModel(state),
		hasKey: state.status.access[choice.provider].key,
		busy: chat.busy || chat.queued.length > 0,
	});
	if (sameModel(choice, chatModel(state))) {
		closeModels(false);
		ui.composer.focus();
		return;
	}
	if (!use.enabled) {
		modelMessage = use.reason;
		renderModelResult();
		return;
	}
	modelPending = true;
	renderModelResult();
	client
		.request({ type: "set-model", rev: state.rev, model: choice })
		.then(
			() => {
				modelMessage = undefined;
				closeModels(false);
				ui.composer.focus();
				announce(t("nowUsing", [shortModel(choice.modelId)]));
			},
			(error: Error) => {
				modelMessage = error.message;
			},
		)
		.finally(() => {
			modelPending = false;
			renderModelResult();
		});
}

filterField(ui.modelFilter, () => {
	renderModels();
	ui.modelList.scrollTop = 0;
	markSelected("nearest");
});
ui.modelFilter.addEventListener("keydown", (event) => {
	if ((event.key !== "ArrowDown" && event.key !== "Enter") || event.isComposing || shownModels.length === 0) return;
	event.preventDefault();
	if (selectedIndex() < 0) selectModel(0, "nearest");
	ui.modelList.focus();
});
const PAGE_ROWS = 5;
ui.modelList.addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		pickModel();
		return;
	}
	const index = selectedIndex();
	const last = shownModels.length - 1;
	const targets: Record<string, number> = {
		ArrowDown: index + 1,
		ArrowUp: index - 1,
		Home: 0,
		End: last,
		PageDown: index + PAGE_ROWS,
		PageUp: index - PAGE_ROWS,
	};
	const target = targets[event.key];
	// Esc is not handled here: it closes the picker.
	if (target === undefined || last < 0) return;
	event.preventDefault();
	selectModel(Math.min(last, Math.max(0, target)), "nearest");
});

ui.model.addEventListener("click", () => {
	if (ui.modelPopup.hidden) openModels();
	else closeModels(true);
});
// A click outside the picker and its chip closes it.
document.addEventListener("pointerdown", (event) => {
	const target = event.target;
	if (target instanceof Node && (ui.modelPopup.contains(target) || ui.model.contains(target))) return;
	closeModels(false);
});
// Tab out of the picker closes it too.
ui.modelPopup.addEventListener("focusout", (event) => {
	const next = event.relatedTarget;
	if (next instanceof Node && (ui.modelPopup.contains(next) || ui.model.contains(next))) return;
	if (next !== null) closeModels(false);
});

// Thinking (design 6.16): one level for all chats, saved when it changes. A chat applies it from the next message
// sent while it is idle.
ui.thinking.addEventListener("change", () => {
	const thinking = ui.thinking.value;
	if (!isThinking(thinking)) return;
	client.request<SettingsSaved>({ type: "set-settings", settings: { thinking } }).then(
		() => announce(t("thinkingLevel", [ui.thinking.selectedOptions[0]?.text ?? thinking])),
		(error: Error) => {
			showComposerError(t("thinkingNotSaved", [error.message]));
			if (state !== undefined) syncSettings(state.settings);
		},
	);
});

ui.openSettings.addEventListener("click", () => {
	if (view === "settings") showView("chat", true);
	else openSettings();
});
ui.closeSettings.addEventListener("click", () => showView("chat", true));

// Settings > Answers, and Sending: each control saves when it changes. The thinking picker in the
// message box shares `syncSettings()`.

const actionRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="selection-action"]')];
const busyRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="enter-while-busy"]')];
const savedTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

function settingsChanged(previous: Settings, next: Settings): boolean {
	return (
		previous.selectionAction !== next.selectionAction ||
		previous.enterWhileBusy !== next.enterWhileBusy ||
		previous.defaultPreset !== next.defaultPreset ||
		previous.language !== next.language ||
		previous.thinking !== next.thinking ||
		JSON.stringify(previous.prompts) !== JSON.stringify(next.prompts) ||
		JSON.stringify(previous.tools) !== JSON.stringify(next.tools) ||
		previous.callsPerAnswer !== next.callsPerAnswer
	);
}

/** The controls from the saved settings. The prompt names follow the language: "Translate to Chinese". */
function syncSettings(settings: Settings): void {
	for (const radio of ui.keys.querySelectorAll<HTMLInputElement>('input[name="openai-web-search"]'))
		radio.checked = (radio.value === "on") === settings.openaiWebSearch;
	for (const radio of actionRadios) radio.checked = radio.value === settings.selectionAction;
	for (const radio of busyRadios) radio.checked = radio.value === settings.enterWhileBusy;
	ui.thinking.value = settings.thinking;
	ui.language.value = settings.language;
	for (const radio of toolRadios) radio.checked = radio.value === settings.tools[toolOf(radio)];
	if (document.activeElement !== ui.callsPerAnswer) ui.callsPerAnswer.value = String(settings.callsPerAnswer);
	syncUserScripts();
	renderPrompts(settings);
}

/** `line`: the result line of the control's section. */
function saveSettings(change: SettingsChange, line: HTMLElement): void {
	clearTimeout(savedTimers.get(line));
	client.request<SettingsSaved>({ type: "set-settings", settings: change }).then(
		({ menuError }) => {
			if (menuError !== null) {
				showResult(line, t("savedMenuFailed", [menuError]), false);
				return;
			}
			showResult(line, t("saved"), true);
			savedTimers.set(
				line,
				setTimeout(() => showResult(line, "", null), 1500),
			);
		},
		(error: Error) => {
			showResult(line, t("notSaved", [error.message]), false);
			if (state !== undefined) syncSettings(state.settings);
		},
	);
}

for (const radio of actionRadios) {
	radio.addEventListener("change", () => {
		if (radio.value === "send" || radio.value === "compose")
			saveSettings({ selectionAction: radio.value }, ui.sendingSaved);
	});
}
for (const radio of busyRadios) {
	radio.addEventListener("change", () => {
		if (isWhenBusy(radio.value)) saveSettings({ enterWhileBusy: radio.value }, ui.sendingSaved);
	});
}
ui.language.addEventListener("change", () => {
	const language = ui.language.value;
	if (isAnswerLanguage(language)) saveSettings({ language }, ui.languageSaved);
});

// Settings > Tools (design 6.23): a mode per page tool, and the calls per answer. One setting for all chats and sites.

const toolRadios = [...document.querySelectorAll<HTMLInputElement>('input[name^="tool-"]')];
const toolOf = (radio: HTMLInputElement) => radio.name.slice("tool-".length) as keyof ToolModes;
for (const radio of toolRadios) {
	radio.addEventListener("change", () => {
		const tool = toolOf(radio);
		const mode = radio.value;
		if ((tool === "act" || tool === "script") && (mode === "off" || mode === "ask" || mode === "on"))
			saveSettings({ tools: { [tool]: mode } }, ui.toolsSaved);
		else if ((tool === "read" || tool === "observe" || tool === "screenshot") && (mode === "off" || mode === "on"))
			saveSettings({ tools: { [tool]: mode } }, ui.toolsSaved);
		if (tool === "script") syncUserScripts();
	});
}
/**
 * Chrome's Allow User Scripts for pi, which run_script needs: while it is off, pi cannot run scripts (design 6.23). Off
 * while Run script is Ask or On is the case to fix, so the line stands out and its button is the primary one; with Run
 * script Off, it stays a quiet note.
 */
function syncUserScripts(): void {
	const allowed = userScriptsAllowed();
	const wanted = toolRadios.some((radio) => toolOf(radio) === "script" && radio.checked && radio.value !== "off");
	const attention = !allowed && wanted;
	ui.userScripts.textContent = t(allowed ? "userScriptsOn" : "userScriptsOff");
	ui.userScriptsRow.classList.toggle("attention", attention);
	ui.openDetails.classList.toggle("primary", attention);
}
syncUserScripts();
ui.toolScript.hidden = !runScriptBuilt();
// The switch is on pi's details page, in a tab: the panel looks again when the user comes back.
window.addEventListener("focus", syncUserScripts);
document.addEventListener("visibilitychange", syncUserScripts);
ui.openDetails.addEventListener("click", () => {
	chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch((error: Error) => {
		showResult(ui.toolsSaved, t("detailsFailed", [error.message]), false);
	});
});
ui.callsPerAnswer.addEventListener("change", () => {
	const calls = Number(ui.callsPerAnswer.value);
	if (!Number.isInteger(calls) || calls < CALLS_PER_ANSWER.min || calls > CALLS_PER_ANSWER.max) {
		showResult(ui.toolsSaved, t("callsRange", [CALLS_PER_ANSWER.min, CALLS_PER_ANSWER.max]), false);
		if (state !== undefined) ui.callsPerAnswer.value = String(state.settings.callsPerAnswer);
		return;
	}
	saveSettings({ callsPerAnswer: calls }, ui.toolsSaved);
});

// Settings > Prompts: one row per prompt, in menu order. Edit opens a form in the row; Add prompt adds a row with the
// form open until it is saved. The switch at the end of a row takes the prompt out of the pi menu and the slash
// commands, and puts it back, without deleting it. A save sends one prompt, and the worker applies it to the prompts as
// saved then, so two panels that edit at once do not undo each other's change.

type PromptRow = {
	node: HTMLElement;
	editing(): boolean;
	update(preset: Preset | undefined, settings: Settings): void;
	open(): void;
	close(): void;
};

const VARIABLE_HELP: Record<PresetVariable, string> = {
	selection: t("variableSelection"),
	title: t("variableTitle"),
	url: t("variableUrl"),
	language: t("variableLanguage"),
};
/** A new prompt: the instruction goes above the selection, where the cursor waits; the answer's language after it. */
const NEW_TEMPLATE = `\n\n{{selection}}${ANSWER}`;
const promptRows = new Map<string, PromptRow>();
/** Numbers the forms: their labels need field IDs. */
let promptForms = 0;
let promptsTimer: ReturnType<typeof setTimeout> | undefined;
/** A move button whose row moved: focus goes back to it, or to its row's other one at an end of the list. */
let promptFocus: HTMLButtonElement | undefined;

function renderPrompts(settings: Settings): void {
	const rows: PromptRow[] = [];
	for (const preset of settings.prompts) {
		let row = promptRows.get(preset.id);
		if (row === undefined) {
			row = promptRow(preset.id, false);
			promptRows.set(preset.id, row);
		}
		row.update(preset, settings);
		rows.push(row);
	}
	// An open form whose prompt is not saved (a new one, or one another panel deleted) stays: Save adds it.
	for (const [id, row] of promptRows) {
		if (settings.prompts.some((preset) => preset.id === id)) continue;
		if (row.editing()) {
			row.update(undefined, settings);
			rows.push(row);
		} else {
			promptRows.delete(id);
		}
	}
	syncChildren(
		ui.prompts,
		rows.map((row) => row.node),
	);
	syncAddPrompt();
	ui.resetPrompts.hidden = JSON.stringify(settings.prompts) === JSON.stringify(PRESETS);
	const moved = promptFocus;
	if (moved !== undefined && document.activeElement !== moved) {
		promptFocus = undefined;
		// Only focus the move dropped: the user may have gone on elsewhere.
		const lost = document.activeElement === null || document.activeElement === document.body;
		const other = moved.parentElement?.querySelectorAll<HTMLButtonElement>(".icon-button:not(.star)");
		const target = moved.disabled ? [...(other ?? [])].find((button) => !button.disabled) : moved;
		if (lost) target?.focus();
	}
}

/** The rows shown count, saved or not; a row the panel removes counts no more before the worker's prompts arrive. */
function syncAddPrompt(): void {
	const full = ui.prompts.children.length >= MAX_PRESETS;
	ui.addPrompt.disabled = full;
	ui.addPrompt.title = full ? t("promptLimit", [MAX_PRESETS]) : "";
}

function promptsSaved(text: string, { menuError }: SettingsSaved): void {
	clearTimeout(promptsTimer);
	if (menuError !== null) {
		showResult(ui.promptsSaved, "", null);
		showResult(ui.promptsResult, t("promptMenuFailed", [text, menuError]), false);
		return;
	}
	showResult(ui.promptsResult, "", null);
	showResult(ui.promptsSaved, t("saved"), true);
	announce(text);
	promptsTimer = setTimeout(() => showResult(ui.promptsSaved, "", null), 1500);
}

/** `fresh`: a prompt that is not saved yet, with its form open. */
function promptRow(id: string, fresh: boolean): PromptRow {
	/** As the worker last sent it. */
	let preset: Preset | undefined;
	/** As saved, until the worker sends the prompts again: they follow the reply. */
	let saved: Preset | undefined;
	let settings: Settings | undefined;
	/** Counts the worker's updates, so a reply knows whether a newer one arrived before it. */
	let updates = 0;
	let mode: "idle" | "edit" | "confirm" = fresh ? "edit" : "idle";
	/** A save or delete is waiting for the worker: the form cannot change, so nothing typed meanwhile is lost. */
	let busy = false;
	/** A switch is waiting for the worker; the switch keeps focus, so it ignores clicks rather than being disabled. */
	let switching = false;
	const form = ++promptForms;

	const star = node("button", "icon-button small star", icon("star"));
	const name = node("span", "name");
	const up = node("button", "icon-button small", icon("up"));
	const down = node("button", "icon-button small", icon("down"));
	const edit = node("button", "small-button edit", t("edit"));
	const toggle = node("button", "switch");
	toggle.setAttribute("role", "switch");
	const shown = node("div", "prompt-head", star, name, up, down, edit, toggle);

	const nameInput = node("input", "");
	nameInput.id = `prompt-name-${form}`;
	nameInput.type = "text";
	nameInput.autocomplete = "off";
	nameInput.maxLength = MAX_PRESET_NAME;
	const nameLabel = node("label", "", t("name"));
	nameLabel.htmlFor = nameInput.id;
	const textInput = node("textarea", "");
	textInput.id = `prompt-text-${form}`;
	textInput.rows = 6;
	textInput.dir = "auto";
	textInput.maxLength = MAX_TEMPLATE_CHARS;
	const textLabel = node("label", "", t("prompt"));
	textLabel.htmlFor = textInput.id;
	const result = node("p", "result");
	result.setAttribute("role", "status");
	const save = node("button", "primary small-button", t("save"));
	const cancel = node("button", "small-button", t("cancel"));
	const remove = node("button", "small-button danger", t("delete"));
	const variables = PRESET_VARIABLES.map(variableButton);
	const editor = node(
		"div",
		"",
		node("div", "field", nameLabel, nameInput),
		node("div", "field", textLabel, textInput),
		node("div", "variables", node("span", "", t("insert")), ...variables),
		result,
		node("div", "row", save, cancel, node("span", "grow"), remove),
	);

	const question = node("p", "");
	const confirmDelete = node("button", "small-button danger", t("delete"));
	const cancelDelete = node("button", "small-button", t("cancel"));
	const confirm = node("div", "confirm", question, node("div", "row", confirmDelete, cancelDelete));
	const row = node("li", "", shown, editor, confirm);

	const current = () => saved ?? preset;
	const label = () => {
		const value = current();
		return value === undefined || settings === undefined
			? t("newPrompt")
			: presetDisplayName(value, effectiveAnswerLanguage(settings.language));
	};
	const changed = () =>
		nameInput.value !== (current()?.name ?? "") || textInput.value !== (current()?.template ?? NEW_TEMPLATE);

	/** Inserts `{{variable}}` at the cursor; the textarea keeps its selection while the button has focus. */
	function variableButton(variable: PresetVariable): HTMLButtonElement {
		const token = `{{${variable}}}`;
		const button = node("button", "", token);
		button.type = "button";
		button.title = VARIABLE_HELP[variable];
		button.setAttribute("aria-label", t("insertVariable", [token, VARIABLE_HELP[variable]]));
		button.addEventListener("click", () => {
			textInput.setRangeText(token, textInput.selectionStart, textInput.selectionEnd, "end");
			textInput.focus();
			check();
		});
		return button;
	}

	/** A placeholder that is not a variable is sent as written: likely a typo, so it is pointed out. */
	function check(): void {
		const unknown = unknownVariables(textInput.value).map((variable) => `{{${variable}}}`);
		showResult(result, unknown.length === 0 ? "" : t("unknownVariable", [unknown.join(", ")]), null);
	}

	function update(next: Preset | undefined, latest: Settings): void {
		preset = next;
		settings = latest;
		saved = undefined;
		updates += 1;
		render();
	}

	function render(): void {
		const value = current();
		name.textContent = label();
		const prompts = settings?.prompts ?? [];
		const index = prompts.findIndex((other) => other.id === id);
		const isDefault = value !== undefined && settings?.defaultPreset === id;
		const on = value === undefined || presetOn(value);
		row.classList.toggle("off", !on);
		star.setAttribute("aria-pressed", String(isDefault));
		star.setAttribute("aria-label", isDefault ? t("defaultPromptAria", [label()]) : t("usePromptAria", [label()]));
		star.title = !on ? t("promptOffStarTip") : isDefault ? t("defaultPromptTip") : t("usePromptTip");
		star.disabled = index < 0 || !on;
		// The default stays on: Ask pi uses it.
		toggle.setAttribute("aria-checked", String(on));
		toggle.setAttribute("aria-label", t("promptSwitchAria", [label()]));
		toggle.title = isDefault ? t("promptDefaultOn") : on ? t("promptOnTip") : t("promptOffTip");
		toggle.disabled = index < 0 || isDefault;
		up.disabled = index <= 0;
		down.disabled = index < 0 || index === prompts.length - 1;
		up.setAttribute("aria-label", t("movePromptUp", [label()]));
		down.setAttribute("aria-label", t("movePromptDown", [label()]));
		up.title = t("moveUpTip");
		down.title = t("moveDownTip");
		edit.setAttribute("aria-label", t("editPromptAria", [label()]));
		nameInput.readOnly = busy;
		textInput.readOnly = busy;
		for (const button of [save, cancel, ...variables, confirmDelete, cancelDelete]) button.disabled = busy;
		remove.hidden = value === undefined;
		remove.disabled = busy || !(settings?.prompts.some((other) => other.id !== id && presetOn(other)) ?? false);
		remove.title = !busy && remove.disabled ? t("promptKeepOne") : "";
		editor.setAttribute("aria-busy", String(busy));
		shown.hidden = mode !== "idle";
		editor.hidden = mode !== "edit";
		confirm.hidden = mode !== "confirm";
	}

	function setMode(next: typeof mode, focus: HTMLElement | undefined): void {
		mode = next;
		render();
		focus?.focus();
	}

	function open(): void {
		const value = current();
		// Edit the stored name, never the localized display name.
		nameInput.value = value?.name ?? "";
		textInput.value = value?.template ?? NEW_TEMPLATE;
		if (value === undefined) textInput.setSelectionRange(0, 0);
		setMode("edit", nameInput);
		check();
	}

	function close(focus: boolean): void {
		if (current() !== undefined) {
			setMode("idle", focus ? edit : undefined);
			return;
		}
		// Never saved, or deleted: the row goes.
		mode = "idle";
		promptRows.delete(id);
		row.remove();
		syncAddPrompt();
		if (focus) ui.addPrompt.focus();
	}

	function saveRow(): void {
		if (settings === undefined || busy) return;
		const next = { id, name: nameInput.value.trim(), template: textInput.value };
		const error = presetError(next, settings.prompts);
		if (error !== undefined) {
			showResult(result, error.text, false);
			(error.field === "name" ? nameInput : textInput).focus();
			return;
		}
		const { language } = settings;
		const seen = updates;
		const focused = document.activeElement instanceof HTMLElement ? document.activeElement : save;
		busy = true;
		render();
		client.request<SettingsSaved>({ type: "save-prompt", prompt: next }).then(
			(reply) => {
				busy = false;
				// Shown until the worker's prompts arrive. Prompts that came first are newer: another panel's save shows,
				// and after another panel's delete the row goes.
				if (updates === seen) saved = next;
				close(true);
				promptsSaved(t("savedPrompt", [presetDisplayName(next, effectiveAnswerLanguage(language))]), reply);
			},
			(error: Error) => {
				busy = false;
				setMode("edit", focused);
				showResult(result, t("notSaved", [error.message]), false);
			},
		);
	}

	edit.addEventListener("click", open);
	toggle.addEventListener("click", () => {
		const value = current();
		if (value === undefined || switching) return;
		const on = !presetOn(value);
		const switched = label();
		const seen = updates;
		switching = true;
		client.request<SettingsSaved>({ type: "switch-prompt", promptId: id, on }).then(
			(reply) => {
				switching = false;
				// Shown until the worker's prompts arrive, as after a save.
				if (updates === seen) {
					saved = { id, name: value.name, template: value.template, ...(on ? {} : { off: true as const }) };
					render();
				}
				promptsSaved(t(on ? "promptTurnedOn" : "promptTurnedOff", [switched]), reply);
			},
			(error: Error) => {
				switching = false;
				showResult(ui.promptsResult, t("notSwitched", [error.message]), false);
			},
		);
	});
	star.addEventListener("click", () => {
		if (settings?.defaultPreset !== id) saveSettings({ defaultPreset: id }, ui.promptsSaved);
	});
	for (const [button, by] of [
		[up, -1],
		[down, 1],
	] as const) {
		button.addEventListener("click", () => {
			const moved = label();
			// The row moves in the list, which takes focus from its button: the next render gives it back.
			promptFocus = button;
			client.request<SettingsSaved>({ type: "move-prompt", promptId: id, by }).then(
				(reply) => promptsSaved(t(by < 0 ? "movedPromptUp" : "movedPromptDown", [moved]), reply),
				(error: Error) => {
					promptFocus = undefined;
					showResult(ui.promptsResult, t("notMoved", [error.message]), false);
				},
			);
		});
	}
	save.addEventListener("click", saveRow);
	cancel.addEventListener("click", () => close(true));
	nameInput.addEventListener("input", check);
	textInput.addEventListener("input", check);
	nameInput.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.isComposing) return;
		event.preventDefault();
		saveRow();
	});
	remove.addEventListener("click", () => {
		if (settings === undefined || busy) return;
		const { language, prompts, defaultPreset } = settings;
		const heir = defaultPreset === id ? prompts.find((other) => other.id !== id && presetOn(other)) : undefined;
		question.replaceChildren(t("deletePromptQuestion", [label()]));
		if (heir !== undefined)
			question.append(
				node("span", "", t("newDefaultPrompt", [presetDisplayName(heir, effectiveAnswerLanguage(language))])),
			);
		setMode("confirm", cancelDelete);
	});
	cancelDelete.addEventListener("click", () => setMode("edit", remove));
	confirmDelete.addEventListener("click", () => {
		if (busy) return;
		const deleted = label();
		const seen = updates;
		busy = true;
		render();
		client.request<SettingsSaved>({ type: "delete-prompt", promptId: id }).then(
			(reply) => {
				// Focus goes to the next prompt's Edit, as in a list after a deletion.
				const neighbor = [row.nextElementSibling, row.previousElementSibling]
					.map((sibling) => sibling?.querySelector<HTMLButtonElement>(".prompt-head > .edit"))
					.find((button) => button != null && button.closest("[hidden]") === null);
				busy = false;
				// Gone until the worker's prompts arrive. Prompts that came first are newer: after another panel saved
				// this prompt again, it stays.
				if (updates === seen) {
					preset = undefined;
					saved = undefined;
				}
				const kept = current() !== undefined;
				close(false);
				(kept ? edit : (neighbor ?? ui.addPrompt)).focus();
				promptsSaved(t("deletedPrompt", [deleted]), reply);
			},
			(error: Error) => {
				busy = false;
				setMode("edit", remove);
				showResult(result, t("notDeleted", [error.message]), false);
			},
		);
	});
	// Esc closes the confirmation or an unchanged form before it would leave Settings; changes are not dropped by it.
	row.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing || mode === "idle") return;
		event.preventDefault();
		if (busy) return;
		if (mode === "confirm") setMode("edit", remove);
		else if (changed()) showResult(result, t("saveOrCancel"), false);
		else close(true);
	});

	return { node: row, editing: () => mode !== "idle", update, open, close: () => close(false) };
}

ui.addPrompt.addEventListener("click", () => {
	if (state === undefined) return;
	const id = crypto.randomUUID();
	const row = promptRow(id, true);
	promptRows.set(id, row);
	renderPrompts(state.settings);
	row.open();
});

function closeReset(focus: HTMLElement | undefined): void {
	ui.resetConfirm.hidden = true;
	ui.promptsActions.hidden = false;
	focus?.focus();
}

ui.resetPrompts.addEventListener("click", () => {
	ui.resetConfirm.hidden = false;
	ui.promptsActions.hidden = true;
	showResult(ui.promptsResult, "", null);
	ui.cancelReset.focus();
});
ui.cancelReset.addEventListener("click", () => closeReset(ui.resetPrompts));
ui.confirmReset.addEventListener("click", () => {
	ui.confirmReset.disabled = true;
	client
		.request<SettingsSaved>({ type: "reset-prompts" })
		.then(
			(reply) => {
				for (const row of promptRows.values()) row.close();
				closeReset(ui.addPrompt);
				promptsSaved(t("promptsRestored"), reply);
			},
			(error: Error) => showResult(ui.promptsResult, t("notReset", [error.message]), false),
		)
		.finally(() => {
			ui.confirmReset.disabled = false;
		});
});
ui.resetConfirm.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.isComposing) return;
	event.preventDefault();
	closeReset(ui.resetPrompts);
});

// Settings > Advanced > Sites: the sites pi reads without a click (design 6.22), each with Remove.

async function renderSites(): Promise<void> {
	const { origins = [] } = await chrome.permissions.getAll();
	ui.allowAllSites.hidden = origins.includes("<all_urls>");
	const kept = [...PROVIDER_IDS.map((provider) => PROVIDERS[provider].origin), CHATGPT.auth, CHATGPT.loopback];
	const sites = allowedSites(origins, kept);
	ui.sites.replaceChildren(...(sites.length === 0 ? [node("li", "muted", t("none"))] : sites.map(siteRow)));
	// Access pi holds for a provider or the ChatGPT sign-in lets it read those sites' pages too (design 6.22).
	const held = kept.filter((origin) => origins.includes(origin)).map(siteName);
	ui.sitesProviders.hidden = held.length === 0;
	ui.sitesHeld.replaceChildren(...held.map((name) => node("li", "", node("span", "", name))));
}

function siteRow(pattern: string): HTMLElement {
	const name = siteName(pattern);
	const remove = node("button", "small-button", t("remove"));
	remove.setAttribute("aria-label", t("removeSiteAria", [name]));
	remove.title = t("removeSiteTip");
	remove.addEventListener("click", () => {
		chrome.permissions.remove({ origins: [pattern] }).then(
			(removed) =>
				showResult(ui.sitesResult, removed ? t("removedSite", [name]) : t("chromeKeptSite", [name]), removed),
			(error: unknown) => showResult(ui.sitesResult, error instanceof Error ? error.message : String(error), false),
		);
	});
	return node("li", "", node("span", "", name), remove);
}

ui.allowAllSites.addEventListener("click", () => {
	// Inside the click: Chrome asks only during a user gesture.
	chrome.permissions.request({ origins: ["<all_urls>"] }).then(
		(granted) => showResult(ui.sitesResult, granted ? t("allSitesAllowed") : t("chromeDenied"), granted),
		(error: Error) => showResult(ui.sitesResult, error.message, false),
	);
});

// Settings > Shortcuts.

/** The bindings Chrome actually assigned: a suggested key that conflicts with another extension stays unset. */
async function renderShortcuts(): Promise<void> {
	const commands = await chrome.commands.getAll();
	ui.shortcuts.replaceChildren(
		...commands
			.filter((command) => command.name !== "_execute_action")
			.map((command) =>
				node(
					"li",
					"",
					node("span", "", command.description ?? command.name ?? ""),
					command.shortcut ? node("kbd", "key", command.shortcut) : node("span", "key muted", t("notSet")),
				),
			),
	);
}

// `chrome://` pages open only through the tabs API, not as links.
ui.editShortcuts.addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
// Settings > Advanced > Data: Delete all chats, after a confirmation in place (design 6.31).
function closeDeleteConfirm(focus: HTMLElement | undefined): void {
	ui.deleteConfirm.hidden = true;
	ui.deleteChats.hidden = false;
	focus?.focus();
}
ui.deleteChats.addEventListener("click", () => {
	ui.deleteConfirm.hidden = false;
	ui.deleteChats.hidden = true;
	showResult(ui.deleteResult, "", null);
	ui.cancelDelete.focus();
});
ui.cancelDelete.addEventListener("click", () => closeDeleteConfirm(ui.deleteChats));
ui.deleteConfirm.addEventListener("keydown", (event) => {
	if (event.key !== "Escape" || event.isComposing) return;
	event.preventDefault();
	closeDeleteConfirm(ui.deleteChats);
});
ui.confirmDelete.addEventListener("click", () => {
	ui.confirmDelete.disabled = true;
	ui.cancelDelete.disabled = true;
	showResult(ui.deleteResult, t("deleting"), null);
	client
		.request({ type: "delete-all-chats" })
		.then(
			() => {
				// A fresh database numbers chats from 1 again.
				removedHere.clear();
				closeDeleteConfirm(ui.deleteChats);
				showResult(ui.deleteResult, t("allChatsDeleted"), true);
				announce(t("allChatsDeleted"));
			},
			(error: Error) => showResult(ui.deleteResult, t("notDeleted", [error.message]), false),
		)
		.finally(() => {
			ui.confirmDelete.disabled = false;
			ui.cancelDelete.disabled = false;
		});
});

ui.openDiagnostics.addEventListener(
	"click",
	() =>
		void chrome.tabs.create({
			url: chrome.runtime.getURL(`diagnostics.html${tabId === null ? "" : `?tab=${tabId}`}`),
		}),
);

renderComposer();
client.start();
