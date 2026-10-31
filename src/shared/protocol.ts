// Messages between extension pages and the service worker over a `chrome.runtime` port named "panel".
//
// The page sends `hello` with the protocol version and its tab; on a mismatch the worker answers `incompatible` and
// disconnects. Otherwise the worker sends a snapshot of the page's state, then batches of changes, each with the next
// sequence number. The page acks every one. A page that falls `MAX_UNACKED` behind gets no batches until it acks, then
// one fresh snapshot. Commands carry an ID and get exactly one reply; chat commands act on the page's tab and carry the
// tab's `rev` the page saw.
// Messages are JSON: an absent value is `null`, never `undefined`.

import type { Preset } from "./presets.ts";

export const PROTOCOL_VERSION = 41;
export const PANEL_PORT = "panel";
export const MAX_UNACKED = 4;

/** `keysUrl`: where the provider's API keys are made, linked from the setup card and Settings. In Settings order. */
export const PROVIDERS = {
	openrouter: {
		name: "OpenRouter",
		origin: "https://openrouter.ai/*",
		keysUrl: "https://openrouter.ai/settings/keys",
	},
	openai: {
		name: "OpenAI",
		origin: "https://api.openai.com/*",
		keysUrl: "https://platform.openai.com/api-keys",
	},
	anthropic: {
		name: "Anthropic",
		origin: "https://api.anthropic.com/*",
		keysUrl: "https://platform.claude.com/settings/keys",
	},
	deepseek: {
		name: "DeepSeek",
		origin: "https://api.deepseek.com/*",
		keysUrl: "https://platform.deepseek.com/api_keys",
	},
} as const;
export type ProviderId = keyof typeof PROVIDERS;

/** The model a new key's provider starts with: fast, cheap, and in pi-ai's catalog (`test/presets.test.ts`). */
export const RECOMMENDED_MODELS: Record<ProviderId, string> = {
	openrouter: "~anthropic/claude-haiku-latest",
	openai: "gpt-5.4-mini",
	anthropic: "claude-haiku-5-5",
	deepseek: "deepseek-flash",
};

/**
 * Sign in with ChatGPT (design 6.20): the host access it adds to OpenAI's API origin, the token endpoint's and the
 * loopback callback's, and OpenAI's usage page, which its UI rules link as "Manage usage".
 */
export const CHATGPT = {
	auth: "https://auth.openai.com/*",
	loopback: "http://127.0.0.1:1455/*",
	usageUrl: "https://chatgpt.com/settings/usage",
} as const;

/** OpenAI's refresh error codes for a session that only a new sign-in brings back (design 6.20). */
export const SIGN_IN_ENDED_CODES: readonly string[] = [
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
];

/** The worker's answer to the callback page's `{type: "chatgpt-callback", search}`. */
export type ChatGPTCallbackReply = { ok: true; welcome: boolean } | { ok: false; error: string };

/**
 * Whether pi-ai would take `key` for a subscription sign-in, which pi does not support (design 6.19). It decides by the
 * value, whatever the stored type: Anthropic by `sk-ant-oat` (`isOAuthToken()`), OpenAI at its default endpoint by a
 * value without `sk-` (`isChatGPTSignIn()`).
 */
export function subscriptionToken(provider: ProviderId, key: string): boolean {
	if (provider === "anthropic") return key.includes("sk-ant-oat");
	return provider === "openai" && !key.startsWith("sk-");
}

export function isProvider(value: string): value is ProviderId {
	return Object.hasOwn(PROVIDERS, value);
}

export type ModelChoice = { provider: ProviderId; modelId: string };

/** The languages pi answers in, by English name, as the prompts and the model read them. */
export const LANGUAGES = ["English", "Chinese"] as const;
export type Language = (typeof LANGUAGES)[number];
/** Stored answer choice; auto follows the supported Chrome interface locale at use time. */
export type AnswerLanguage = Language | "auto";

export function isLanguage(value: unknown): value is Language {
	return (LANGUAGES as readonly unknown[]).includes(value);
}

export function isAnswerLanguage(value: unknown): value is AnswerLanguage {
	return value === "auto" || isLanguage(value);
}

/**
 * How much the model thinks before it answers (design 6.16, 6.35); a model without the level gets the nearest lower
 * one it has, and one without reasoning gets none.
 */
export const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/**
 * What a model gets for a thinking level: one of pi-ai's levels, which include `minimal`, or `default` for Off on a
 * model that cannot turn thinking off, so the provider's default applies.
 */
export type SentThinking = Thinking | "minimal" | "default";

export function isThinking(value: unknown): value is Thinking {
	return (THINKING_LEVELS as readonly unknown[]).includes(value);
}

/** A page tool's mode (design 6.23): Off is not offered to the model; Ask shows a card first; On runs without one. */
export type ToolMode = "off" | "ask" | "on";

/** The modes in Settings > Tools, for every chat and site. Reading, observing, and screenshots have no Ask. */
export type ToolModes = {
	read: "off" | "on";
	observe: "off" | "on";
	act: ToolMode;
	script: ToolMode;
	screenshot: "off" | "on";
};

/** "Page tool calls per answer": all page tools together. */
export const CALLS_PER_ANSWER = { min: 5, max: 200, default: 50 } as const;

/**
 * A message sent while the chat runs: `steer` joins the running task after its current tool round, `followUp` waits
 * for the answer and starts the next run (design 6.39).
 */
export type WhenBusy = "steer" | "followUp";

export function isWhenBusy(value: unknown): value is WhenBusy {
	return value === "steer" || value === "followUp";
}

export type Settings = {
	/** Hosted web search for native OpenAI Responses requests, with either an API key or ChatGPT sign-in. */
	openaiWebSearch: boolean;
	/** Model of new chats; choosing a model for the open chat also makes it the default. */
	model: ModelChoice;
	/** What "Ask pi" and the hotkey do with a selection: send it with the default preset, or put it in the composer. */
	selectionAction: "send" | "compose";
	/** What Enter does with a message while the chat runs; Alt+Enter does the other (design 6.39). */
	enterWhileBusy: WhenBusy;
	/** The ID of one of `prompts`. */
	defaultPreset: string;
	/** Answer language and Translate target; independent of UI language. auto remains automatic when saved. */
	language: AnswerLanguage;
	/** Set on a chat when a message is sent to it while it is idle. */
	thinking: Thinking;
	/** The prompts of the selection menu, in order; at least one. The built-in ones until the user edits them. */
	prompts: Preset[];
	tools: ToolModes;
	/** From `CALLS_PER_ANSWER.min` to `.max`. */
	callsPerAnswer: number;
};

/** A change from Settings: the modes it names replace those saved, the others stay. */
export type SettingsChange = Partial<Omit<Settings, "model" | "prompts" | "tools">> & {
	tools?: Partial<ToolModes>;
};

export const MAX_TITLE_CHARS = 300;
export const MAX_URL_CHARS = 2048;

/** `text` up to `end` UTF-16 units, without a high surrogate at the end: one less where `end` would split a pair. */
export function cut(text: string, end: number): string {
	const stop = Math.min(end, text.length);
	const code = text.charCodeAt(stop - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? stop - 1 : stop);
}

/** A page's title as pi uses it: one line, bounded, well-formed. The page sets it, so it may be long or hold line breaks. */
export function pageTitle(title: string): string {
	return cut(title.replace(/\s+/g, " ").trim().toWellFormed(), MAX_TITLE_CHARS);
}

/**
 * A page an input is about, captured at a gesture or New chat. `documentId` identifies that capture, or is null when
 * the page could not be read. Page tools use current pages (design 6.22).
 */
export type PageRef = {
	tabId: number;
	frameId: number;
	documentId: string | null;
	url: string;
	title: string;
	capturedAt: number;
};

/**
 * The page captured for a tab, with its top-level URL key: the key of a chat that a typed message about this page
 * starts (design 6.17). It travels with the page to the panel and back, so a newer capture cannot give an older page
 * its key.
 */
export type AttachedPage = PageRef & { key: string | null };

/** `data` of a `web.selection` entry, and the selection of a draft. The source is also in the prompt text. */
export type SelectionData = {
	text: string;
	/** Name of the preset the prompt was made with, as shown then ("Translate to German"). */
	preset: string;
	page: PageRef;
};

/**
 * `data` of a `web.selection` entry. `edited`: the user changed the prompt in the composer before sending, so the panel
 * shows the sent text instead of the preset and the quote. Entries stored without it count as edited.
 */
export type SelectionEntryData = SelectionData & { edited: boolean; attachments?: AttachmentInfo[] };

/**
 * An attachment as an input's entry stores it and the panel shows it (design 6.42), in the order of its content blocks.
 * `chars`: a file's characters; an image's base64 characters.
 */
export type AttachmentInfo =
	| { kind: "file"; name: string; chars: number }
	| { kind: "image"; width: number; height: number; chars: number };

/** An attachment a send carries: a text file's name and text, or an image as the panel encoded it (design 6.42). */
export type MessageAttachment =
	| { kind: "file"; name: string; text: string }
	| { kind: "image"; width: number; height: number; image: StoredImage };

/** `data` of a `web.input` entry: a typed message with attachments and neither a page nor a selection (design 6.42). */
export type InputData = { text: string; attachments: AttachmentInfo[] };

/**
 * `data` of a `web.message` entry: a typed message with the tab's page attached, or a prompt sent from the menu for the
 * page. The prompt adds the page.
 */
export type MessageData = {
	/** What the user typed, or the filled prompt. */
	text: string;
	page: PageRef;
	/** A prompt from the page menu, sent unchanged: its name ("Summarize"), which the panel shows instead of `text`. */
	prompt?: string;
	/** Where the tab was when the message was sent, if it no longer showed `page` (design 6.28). */
	moved?: PageMove;
	/** What the user attached (design 6.42). */
	attachments?: AttachmentInfo[];
};

/**
 * A tab that left its attached page: the page it shows, when pi may script it; else the site pi last saw the tab sent
 * to, null when pi does not know it (design 6.28).
 */
export type PageMove = { url: string; title: string } | { site: string | null };

/** The newest capture, shown for diagnostics. */
export type Attachment = {
	via: "context-menu" | "command" | "action";
	tabId: number;
	frameId: number;
	documentId?: string;
	url: string;
	title: string;
	capturedAt: number;
	selection?: string;
	/** `dom` when read from the page, `selectionText` when Chrome's flattened copy was the fallback. */
	selectionSource?: "dom" | "selectionText";
	/** Of the top page: whether its URL's fragment names an element in it. Absent when unknown or without a fragment. */
	anchor?: boolean;
	error?: string;
};

export type Command =
	/**
	 * `conversationId`: the chat the page saw, null for none; a resend finds its admission there. `draftId`: the draft
	 * this text came from, removed once admitted.
	 */
	| {
			type: "send";
			rev: number;
			conversationId: number | null;
			requestId: string;
			text: string;
			draftId: string | null;
			/** Send the draft's selection as a `web.selection` input; false sends the text, with `page` if not null. */
			quote: boolean;
			/** Without a quote: the page to attach, as the panel showed it; null attaches none. */
			page: AttachedPage | null;
			/** Used only while the chat runs or has queued inputs. */
			whenBusy: WhenBusy;
			/** Images and text files, in the order added; with one, `text` may be empty (design 6.42). */
			attachments: MessageAttachment[];
	  }
	| { type: "retry"; rev: number; conversationId: number; entryId: number; requestId: string }
	/**
	 * Edit (design 6.34): the chat up to input `entryId`, then `text` in its place, as a new chat the tab shows. `keep`:
	 * the indexes of the input's attachments that go with it (design 6.42).
	 */
	| {
			type: "edit";
			rev: number;
			conversationId: number;
			entryId: number;
			text: string;
			keep: number[];
			requestId: string;
	  }
	/** Stop: the tab's chat stops its run and withdraws its queued inputs, whose text becomes the tab's drafts. */
	| { type: "abort"; rev: number }
	/** The tab starts fresh; the chat it leaves keeps working. `attachPage` is false after Don't attach. */
	| { type: "new-chat"; rev: number; attachPage: boolean }
	/**
	 * The tab shows chat `target`; the chat it leaves keeps working. `createdAt`, from a History row: the chat as
	 * History listed it, so after Delete all an old row does not reach a new chat with the same ID. Also below.
	 */
	| { type: "open-chat"; rev: number; target: number; createdAt?: number }
	/** Returns `ChatSummary[]`: running chats first, then the others newest first. */
	| { type: "list-chats" }
	/** History (design 6.30): a chat's title, "" for its first input's; Remove and its Undo; Markdown to download. */
	| { type: "rename-chat"; target: number; createdAt?: number; title: string }
	| { type: "remove-chat"; target: number; createdAt?: number }
	| { type: "restore-chat"; target: number; createdAt?: number }
	/** Returns `ChatExport`. */
	| { type: "export-chat"; target: number; createdAt?: number }
	/** Erases every chat; settings, keys, and the sign-in stay (design 6.31). */
	| { type: "delete-all-chats" }
	/** The model of the tab's chat, if it has one, and of new chats. */
	| { type: "set-model"; rev: number; model: ModelChoice }
	/** Returns `SettingsSaved`, as the prompt commands below do. */
	| { type: "set-settings"; settings: SettingsChange }
	/** Replaces the prompt with this ID, or adds it at the end. Rejected with the reason when it is not valid. */
	| { type: "save-prompt"; prompt: Preset }
	| { type: "delete-prompt"; promptId: string }
	/** Turns a prompt on or off: off keeps it in Settings, out of the pi menu and the slash commands. */
	| { type: "switch-prompt"; promptId: string; on: boolean }
	/** Moves a prompt one place up (-1) or down (1) in the menu order, among the prompts as saved then. */
	| { type: "move-prompt"; promptId: string; by: -1 | 1 }
	/** The built-in prompts again; the user's own are deleted. */
	| { type: "reset-prompts" }
	| { type: "discard-draft"; draftId: string }
	| { type: "dismiss-notice"; noticeId: string }
	/** The user's answer to an Ask card of the tab's chat; rejected when the card is gone. */
	| { type: "answer-ask"; askId: string; answer: AskReply }
	/**
	 * Returns image `index` of entry `entryId` of the tab's chat, as the model got it, or null (design 6.26, 6.42): a
	 * screenshot's is 0, an input's counts its attached images in order.
	 */
	| { type: "get-image"; entryId: number; index: number }
	/** Returns whether the tab's media moved to the time of `url`, a link to its own page (design 6.38). */
	| { type: "play-at"; url: string }
	| { type: "set-key"; provider: ProviderId; key: string }
	| { type: "verify-key"; provider: ProviderId }
	/**
	 * Opens OpenAI's sign-in in a tab next to `tabId`: to the saved account, or with `another`, to a new one. A sign-in
	 * still waiting is replaced (design 6.20).
	 */
	| { type: "chatgpt-sign-in"; tabId: number | null; another: boolean }
	| { type: "chatgpt-cancel" }
	/** Returns `{revoked}`: whether OpenAI confirmed the end of the session. */
	| { type: "chatgpt-sign-out" }
	| { type: "list-models" }
	| { type: "set-keepalive"; enabled: boolean }
	| { type: "conformance" }
	| { type: "clear-log" };

/** An image in a chat, such as a screenshot: base64 `data` of type `mimeType`. */
export type StoredImage = { mimeType: string; data: string };

/** The settings are saved; `menuError` says why the pi menu did not update, or is null. */
export type SettingsSaved = { menuError: string | null };

/**
 * `reasoning`: the model can think, so the thinking level applies to it. `thinking`: what pi-ai sends it for each
 * level (design 6.35); all `off` for a model that cannot think.
 */
export type ModelInfo = {
	provider: ProviderId;
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	thinking: Record<Thinking, SentThinking>;
	contextWindow: number;
};

export type ProviderAccess = { key: boolean; permission: boolean; plan: boolean; planModels: string[] | null };

export type Status = {
	boot: number;
	workerStartedAt: number;
	harnessOpenMs: number | null;
	harnessError: string | null;
	/** Chrome refused a write because the extension's storage is full (design 8). */
	storageFull: boolean;
	/**
	 * Per provider: a key or a ChatGPT sign-in (`plan`) is stored, and the user granted the host access it needs. A
	 * sign-in's `planModels`: the IDs of the models its plan offers, or null until a fetch succeeded.
	 */
	access: Record<ProviderId, ProviderAccess>;
	/**
	 * Sign in with ChatGPT (design 6.20). `waiting`: a sign-in waits for its callback. `account`: the account pi signs
	 * in to, kept after sign-out, or null. `ended`: OpenAI ended the stored sign-in; only a new one helps.
	 */
	chatgpt: { waiting: boolean; account: { email: string | null } | null; ended: boolean };
	/** Last Harness Wake; null before attachment or after close. Deadlines are epoch milliseconds. */
	wake: { active: boolean; at: number | null } | null;
	/** Diagnostics switch: off lets Chrome stop the worker during long requests. */
	keepaliveEnabled: boolean;
	keepalive: boolean;
	attachment: Attachment | null;
};

/**
 * Tokens as the provider reported them, and their cost in US dollars as pi-ai estimates it from its model prices; 0
 * where it has no price for the model. `planCost`: what the calls on a ChatGPT plan, which cost nothing, would cost at
 * those prices. `input` excludes the cache reads and writes. `cacheHit`: the share of the prompt read from the cache, 0
 * to 1, over all of an answer's calls, and of the last call for a chat's line; null without a prompt (design 6.21).
 */
export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	planCost: number;
	cacheHit: number | null;
};

/**
 * Of an answer: how long its turn took and the tools it called (design 6.21). `modelMs`: the model calls' time, null
 * when one has no recorded duration, as calls stored before pi-ai measured it. `toolMs`: the time tools ran, overlaps
 * counted once, without the waits for the user's approval before them. `tools`: by name, in the order first called.
 */
export type AnswerStats = {
	modelMs: number | null;
	toolMs: number;
	tools: { name: string; calls: number; failed: number }[];
};

/**
 * One chat in the history list. `page`: the first page an input was about, null for none. `active`: the page's tab shows
 * it. `running`: it answers or summarizes.
 */
export type ChatExport = { title: string; markdown: string };

/** The longest title a chat can be given in History. */
export const MAX_CHAT_TITLE = 120;

export type ChatSummary = {
	id: number;
	createdAt: number;
	title: string;
	page: { url: string; title: string } | null;
	active: boolean;
	running: boolean;
	/** Made by Edit from another chat (design 6.34). */
	edited: boolean;
};

export type ChatEntry = {
	id: number;
	role: "user" | "assistant" | "notice";
	/** Markdown for an answer; plain text otherwise. An input's text is what the user sent, without the page note. */
	text: string;
	/** Of a selection sent with its preset prompt unchanged: the panel shows these instead of `text`. */
	quote: { preset: string; text: string } | null;
	/** Of an input: the page it is about. */
	source: { title: string; url: string } | null;
	/** Of a typed message: where the tab was when it was sent, if it no longer showed `source` (design 6.28). */
	moved?: PageMove;
	/** Why an answer ended early: the provider error or a localized Stop explanation. */
	error: string | null;
	/** True for an aborted answer; absent otherwise. Classify Stop without inspecting display text. */
	stopped?: boolean;
	/** Of an answer: what the model thought before it, if the provider returned it. */
	thinking: string | null;
	/**
	 * Of the answer that ends a turn: all the turn's model calls, those before each tool call too; null on steps. Set
	 * when the turn ends, on an entry a panel may already show: unlike the rest, it changes without the ID.
	 */
	usage: Usage | null;
	/** Of the answer that ends a turn, as `usage`; null while the turn runs. */
	stats: AnswerStats | null;
	/** Of a notice: a second line, such as what an action on the page did. */
	detail: string | null;
	/** Of a tool's line: its result has an image, such as a screenshot, which `get-image` returns. */
	image: boolean;
	/**
	 * A step on the way to an answer: a tool's line, or what the model said before a tool call. The panel draws steps
	 * as one log; a compaction's or a reset's notice is not one (design 6.23).
	 */
	step: boolean;
	/** Successful page-read kind, for merging notices without inspecting translated display text. */
	read?: "page" | "selection";
	/** Of an input: its text as written or as the prompt filled it, without the page note; Copy and Edit use it. */
	sent?: string;
	/** Of an input: what the user attached, in order; absent without any (design 6.42). */
	attachments?: AttachmentInfo[];
	/** Of a tool's line: an action on a page or a script ran, which Edit does not undo (design 6.34). */
	acted?: true;
};

/** An input admitted while the chat is busy, and whether it joins the running task or waits for its answer. */
export type QueuedInput = Pick<ChatEntry, "id" | "text" | "quote" | "source" | "sent" | "moved" | "attachments"> & {
	mode: WhenBusy;
};

export type ChatView = {
	conversationId: number | null;
	model: ModelChoice | null;
	/** The whole transcript, also what a compaction summarized. */
	entries: ChatEntry[];
	/** The answer being generated, as last committed; `thinking` is "" until the model thinks. */
	live: { text: string; thinking: string; attempt: number; retry: string | null } | null;
	busy: boolean;
	/** Inputs admitted while busy, waiting for the run's next tool round (steers) or its end (follow-ups). */
	queued: QueuedInput[];
	/** The newest input, when the chat is idle and it has no complete answer. */
	retry: number | null;
	/** Everything the chat spent: answers, summaries, and tools. */
	usage: Usage | null;
	/**
	 * While the chat runs: when its run started, as the worker first saw it, and the tool results of its turn so far,
	 * for the live answer's line (design 6.21); and the ID of its first entry, from which its steps stay open (design
	 * 6.23). Null otherwise.
	 */
	progress: { startedAt: number; tools: number; from: number } | null;
	/** Current context, not cumulative spend; unknown after compaction until a new model response. */
	context: { tokens: number | null; auto: boolean };
	/** The chat this one was edited from, while History lists it (design 6.34); null otherwise. */
	editedFrom: number | null;
};

/**
 * Text that was not sent: a compose-mode selection, a selection or page prompt send that failed before admission, an
 * input Stop withdrew from the queue, or selected text for "Add to message".
 */
export type Draft = {
	id: string;
	tabId: number;
	createdAt: number;
	text: string;
	selection: SelectionData | null;
	/** Of a page prompt: the page it was made for, which it attaches instead of the tab's page (design 6.18). */
	page: AttachedPage | null;
	/** Of a page prompt: its name. */
	prompt: string | null;
	/** The URL key of the gesture's top-level page: the key of a chat this draft's selection starts. */
	key: string | null;
	/** Why it was not sent. */
	note: string | null;
	/** "Add to message": the panel adds the text to the message box, after what is there, and never lists it. */
	insert: boolean;
};

export type Notice = { id: string; text: string };

/**
 * Allow (for a site card: after Chrome allowed it), or Deny (Cancel). A script card's "answer": run this script and,
 * without a card, the next ones on its site until the answer ends; "chat": also in the chat's later answers (design
 * 6.23).
 */
export type AskReply = "allow" | "answer" | "chat" | "deny";

/**
 * A card that waits for the user (design 6.23, 6.28): pi needs a site Chrome has not allowed, `origin` when pi knows it
 * (null: it cannot name it); may it act on `origin`, or run this script there? A script's `summary` is the model's words.
 */
export type AskCard =
	| { id: string; kind: "site"; origin: string | null }
	| { id: string; kind: "act"; origin: string }
	| { id: string; kind: "script"; origin: string; summary: string | null; code: string };

/** Everything a page shows. The chat, drafts, and the notice are those of the page's tab. */
export type PanelState = {
	status: Status;
	settings: Settings;
	chat: ChatView;
	/** The tab's count of New chat and History, which chat commands carry. */
	rev: number;
	/** The start time of the chat the tab continued by its page, until the tab's next send. */
	resumed: number | null;
	drafts: Draft[];
	/** Gesture sends, a selection's or a page prompt's, between the click and admission. */
	sending: number;
	/** The page captured for the tab at a gesture or New chat: what a typed message attaches. */
	page: AttachedPage | null;
	notice: Notice | null;
	/** The Ask cards of the tab's chat, oldest first. */
	asks: AskCard[];
	/** Diagnostics log; empty unless the page asked for it. */
	log: string[];
};

/** A change of the chat: entries from index `from` on are replaced; the other fields are the new values. */
export type ChatPatch = Omit<ChatView, "entries"> & { from: number; entries: ChatEntry[] };

export type StatePatch = { [K in Exclude<keyof PanelState, "chat">]?: PanelState[K] } & { chat?: ChatPatch };

export type PageMessage =
	/** `tabId`: from the page's path; null for a page without a tab. */
	| { type: "hello"; version: number; tabId: number | null; log: boolean }
	| { type: "ack"; seq: number }
	| { type: "command"; id: string; command: Command };

export type WorkerMessage =
	| { type: "incompatible"; version: number }
	| { type: "snapshot"; seq: number; state: PanelState }
	| { type: "batch"; seq: number; patch: StatePatch }
	| { type: "reply"; id: string; ok: true; result: unknown }
	| { type: "reply"; id: string; ok: false; error: string };

export function applyPatch(state: PanelState, patch: StatePatch): PanelState {
	const { chat, ...rest } = patch;
	const next = { ...state, ...rest };
	if (chat !== undefined) {
		const { from, entries, ...fields } = chat;
		next.chat = { ...fields, entries: [...state.chat.entries.slice(0, from), ...entries] };
	}
	return next;
}

/**
 * Whether a panel can keep `last` for `next`. An entry changes with its ID, but for the usage and stats that its
 * turn's end adds (design 6.21): those compare by value, and they are small, unlike the text.
 */
export function sameEntry(last: ChatEntry, next: ChatEntry): boolean {
	return (
		last.id === next.id &&
		JSON.stringify(last.usage) === JSON.stringify(next.usage) &&
		JSON.stringify(last.stats) === JSON.stringify(next.stats)
	);
}

/** What changed from `last` to `next`; undefined when nothing did. Entries compare as `sameEntry` does. */
export function diffState(last: PanelState, next: PanelState): StatePatch | undefined {
	const patch: StatePatch = {};
	let changed = false;
	for (const key of Object.keys(next) as (keyof PanelState)[]) {
		if (key === "chat" || JSON.stringify(last[key]) === JSON.stringify(next[key])) continue;
		Object.assign(patch, { [key]: next[key] });
		changed = true;
	}
	const { entries, ...fields } = next.chat;
	const { entries: lastEntries, ...lastFields } = last.chat;
	let from = 0;
	if (fields.conversationId === lastFields.conversationId) {
		while (from < entries.length && from < lastEntries.length && sameEntry(lastEntries[from]!, entries[from]!))
			from += 1;
	}
	if (from < entries.length || from < lastEntries.length || JSON.stringify(fields) !== JSON.stringify(lastFields)) {
		patch.chat = { ...fields, from, entries: entries.slice(from) };
		changed = true;
	}
	return changed ? patch : undefined;
}

/** The origin of an http or https URL, such as "https://example.com"; null for other URLs (design 6.28). */
export function siteOrigin(url: string): string | null {
	try {
		const { protocol, origin } = new URL(url);
		return protocol === "https:" || protocol === "http:" ? origin : null;
	} catch {
		return null;
	}
}
