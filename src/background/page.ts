// The `read_page` tool: the model reads the tab of the page attached to the user's latest message, in chunks of one
// snapshot (design 6.9, 6.22); and what all page tools share (6.23): Chrome access, the run's state, and the checks.

import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type Message, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type Cursor,
	type DocumentReader,
	defineDoc,
	defineTool,
	type EntryRecord,
	type JsonObject,
	LiveDoc,
	type Page,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { base64 } from "../shared/images.ts";
import {
	cut,
	MAX_URL_CHARS,
	type PageMove,
	type PageRef,
	pageTitle,
	type Settings,
	siteOrigin,
} from "../shared/protocol.ts";
import { userScriptsAllowed } from "../shared/user-scripts.ts";
import type { Asks } from "./asks.ts";
import { type MediaState, mediaState } from "./media.ts";
import {
	type ActRequest,
	type ActResult,
	type LocateRequest,
	type LocateResult,
	type ObserveRequest,
	type ObserveResult,
	pageAgent,
	type ScrollRequest,
	type ScrollResult,
} from "./page-agent.ts";
import { INPUT_KINDS, pageOf } from "./projection.ts";
import { type CaptureQueue, type Crop, dataBytes, imageRect, tabChangeCount, watchTab } from "./screenshot.ts";
import { runScript } from "./script-runner.ts";
import { ScopeDenied, type TabGroups } from "./tab-groups.ts";
import { urlKey } from "./url-key.ts";

export const LIST_TABS = "list_tabs";
export const READ_PAGE = "read_page";
export const OBSERVE_PAGE = "observe_page";
export const ACT_ON_PAGE = "act_on_page";
export const RUN_SCRIPT = "run_script";
export const SCREENSHOT_PAGE = "screenshot_page";
export const WAIT_ON_PAGE = "wait_on_page";
/** Text kept of one page; the rest is cut and the result says so. */
export const MAX_PAGE_CHARS = 200_000;
/** UTF-8 size of one result, the envelope included. */
export const MAX_RESULT_BYTES = 40 * 1024;
const DEFAULT_LIMIT = 12_000;
const MAX_LIMIT = 30_000;
/** How long a call waits for the page; a busy or frozen tab must not hold Stop and New chat. */
export const PAGE_TIMEOUT_MS = 10_000;
/** How long the reader may walk the tab's documents, all frames together; the rest is left out, and the result says so. */
const READ_BUDGET_MS = 6_000;
/** Frames read, the top one included; more are left out, and the result says so. */
export const MAX_FRAMES = 20;
/** Newest action-attributed tabs retained for a chat, not an access limit. */
export const MAX_OPENED_TABS = 20;

/** A frame of the tab (design 6.22): where it is, and whether it shows: each `<iframe>` above it is visible. */
export type FrameInfo = { frameId: number; documentId: string; url: string; origin: string; shown: boolean };

/**
 * What the reader found in one document: its text, at most the `maxChars` asked for, the length of all it read, and
 * whether it read all of the document in its time.
 */
export type FrameText = { url: string; title: string; text: string; length: number; complete: boolean };

export type ReadScope = "page" | "selection";

/** The tab's top document as it is now. */
/**
 * `anchor`: whether the URL's fragment names an element by ID or an `<a name>`, a place in the page rather than an
 * app's state (design 6.17); null without a fragment, absent when not checked.
 */
export type TopDocument = { documentId: string; url: string; origin: string; title: string; anchor?: boolean | null };

/** The tab's window, active/minimized state, and window focus when known. */
export type TabState = { windowId: number; active: boolean; minimized: boolean; focused?: boolean };

/** A JPEG image as base64, and its size in pixels. */
export type Encoded = { data: string; width: number; height: number };

/** Reuses the call's guard for every request inside a composite native helper. */
type PageDispatch = <T>(request: () => Promise<T>) => Promise<T>;

/** Chrome access, replaced in tests. */
export type PageAccess = {
	/** Each frame of the tab that pi may script; rejects when the tab is gone. */
	frames(tabId: number): Promise<FrameInfo[]>;
	/**
	 * The text of one document, at most `maxChars`, reading for about `budgetMs`. Null for a document without a body.
	 * `scope` defaults to the whole page; selection scope keeps only selected body text.
	 * Rejects when the document is gone or pi may not script it.
	 */
	text(
		tabId: number,
		documentId: string,
		maxChars: number,
		budgetMs: number,
		scope?: ReadScope,
	): Promise<FrameText | null>;
	/** The document's URL now; null when it is no longer in the tab. */
	current(tabId: number, documentId: string): Promise<string | null>;
	/** The tab's top document; null when the tab is gone or pi may not script it. */
	top(tabId: number): Promise<TopDocument | null>;
	/** Runs the page agent in the document. Null when the document went away during the call. */
	observe(tabId: number, documentId: string, request: ObserveRequest): Promise<ObserveResult | null>;
	act(tabId: number, documentId: string, request: ActRequest): Promise<ActResult | null>;
	/**
	 * Loads `url` in the tab, or reloads its page, from inside document `documentId`: Chrome sends it only while pi may
	 * script that document (design 6.28). The request goes to Chrome before the first await.
	 */
	navigate(tabId: number, documentId: string, url: string): Promise<void>;
	/** Waits until the tab has loaded, at most `ms`; false when it has not by then. */
	loaded(tabId: number, ms: number, signal: AbortSignal, dispatch?: PageDispatch): Promise<boolean>;
	/** Whether Chrome lets pi run scripts: its Allow User Scripts switch for pi is on. */
	scripts(): boolean;
	/** Sets up pi's script world; it runs nothing. */
	scriptWorld(): Promise<void>;
	/**
	 * Runs `code` with `runScript` in pi's script world in the document, and gives its JSON text of at most `maxBytes`.
	 * Null when no result came back. The request goes to Chrome before the first await: the caller's checks just before
	 * the call are the last ones.
	 */
	script(tabId: number, documentId: string, code: string, maxBytes: number): Promise<string | null>;
	/**
	 * The medium wait `key` follows in the document (design 6.40), chosen at its first check. Null when the document went
	 * away during the call.
	 */
	media(tabId: number, documentId: string, key: string): Promise<MediaState | null>;
	/** Where the element is, without scrolling. Null when the document went away during the call. */
	locate(tabId: number, documentId: string, request: LocateRequest): Promise<LocateResult | null>;
	/**
	 * Scrolls the page or an element before a screenshot, and waits until it is drawn. Null when the document went away
	 * during the call. The request goes to Chrome before the first await.
	 */
	scroll(tabId: number, documentId: string, request: ScrollRequest): Promise<ScrollResult | null>;
	/** Null when the tab is gone. */
	tabState(tabId: number, dispatch?: PageDispatch): Promise<TabState | null>;
	/** Whether Chrome allows pi on all sites (`<all_urls>`, design 6.28). */
	allSites(): Promise<boolean>;
	/** The site pi last sent the tab to, by a link it clicked or a URL it loaded, if known (design 6.28). */
	leadsTo(tabId: number): string | null;
	/** Tab events counted from the worker's start (design 6.26). */
	changes(): number;
	/** Counts the tab's navigations in `changes()` too, until the function it returns is called. */
	watch(tabId: number): () => void;
	/** Notes the tabs opened from the tab (design 6.29) until the function it returns is called, which gives them. */
	opened(tabId: number): () => number[];
	/** Returns to the attached tab only if an accepted opening is now active in its original window. */
	switchBack(
		tabId: number,
		opened: readonly number[],
		windowId: number,
		check?: () => void,
		dispatch?: PageDispatch,
	): Promise<number | null>;
	/** Closes the tab; false when it was already closed. */
	close(tabId: number): Promise<boolean>;
	/** What the window's active tab shows, as a PNG `data:` URL. */
	capture(windowId: number): Promise<string>;
	/** The PNG `png`, cut to `crop` if given, shrunk so that its long side is at most `longSide`, as JPEG. */
	encode(png: string, crop: Crop | null, longSide: number, quality: number): Promise<Encoded>;
	now?(): number;
	timeoutMs?: number;
	/** How long run_script waits for a script. */
	scriptMs?: number;
	/** How often wait_on_page checks the page. */
	pollMs?: number;
};

/**
 * What the page tools read at each call: the modes and the call limit of Settings > Tools, as
 * they are now.
 */
export type PageToolSettings = Pick<Settings, "tools" | "callsPerAnswer">;

/** Why the page tools do not use the tab's top page `top`, which is not on a site (about:blank, data:). */
export function notSiteText(top: { url: string }): string {
	return `The tab shows ${top.url.slice(0, MAX_URL_CHARS)}, which the page tools cannot use.`;
}

/** What the page extension needs from the worker. */
export type PageDeps = {
	access: PageAccess;
	settings(): Promise<PageToolSettings>;
	/** Cached policy, read synchronously at the actual native dispatch. */
	currentSettings(): PageToolSettings;
	groups: TabGroups;
	/** Current browser-session ID; loaded before any recovered page tool resumes. */
	browserSession(): string;
	/** Current session binding: absent is unbound, null/undefined chat is fresh/unresolved. */
	binding(tabId: number): { chat?: number | null } | undefined;
	asks: Asks;
	/** The chat's entries, newest first, as `Conversation.entries()` gives them. */
	entries(
		conversationId: ConversationId,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	/** The messages of the chat's next request, as `Conversation.context()` gives them. */
	context(conversationId: ConversationId, context: Context): Promise<readonly Message[]>;
	/** The worker's one queue of captures (design 6.26). */
	captures: CaptureQueue;
	/** Internal bounded wait paired with a call-local access guard. */
	wait?: typeof bounded;
};

export type Snapshot = {
	/** Absent in whole-page and older snapshots. Each scope has its own snapshot and offsets. */
	scope?: ReadScope;
	/** The tool task that took it. */
	id: number;
	/** The attached page's document, or `tab <id>` for another tab of the run (6.29): a later read of the run finds the snapshot by it. */
	documentId: string;
	/** The document read: the tab's top one, or a frame's for a selection in it; absent in older snapshots (6.22). */
	read?: string;
	/** The page read did not have the attached page's URL. */
	pageChanged?: true;
	url: string;
	title: string;
	takenAt: number;
	text: string;
	/** Extraction was incomplete or the requested text exceeded the snapshot limit. */
	truncated: boolean;
};

/**
 * `run`: the submission ID of the run's first input. `calls`: the page tool calls of the run, by tool task. `tabs`: the
 * newest tabs the chat's accepted actions opened (provenance only), stamped with `tabsSession`. `tab`: the selected
 * stable Chrome ID for this run, or null for the attached tab.
 */
export type PageReads = {
	run: number;
	calls: number[];
	snapshots: Snapshot[];
	tabs: number[];
	tabsSession: string | null;
	tab: number | null;
};

/**
 * The page tool calls and the snapshots of the chat's current run. The first page tool call of the next run starts it
 * over; releasing the chat clears temporary state but retains its stamped tab ownership. Each chat holds at most
 * one run's snapshots. Changes are stored as deltas; the state without snapshots, written when a run starts over or an action drops them, is stored whole, which
 * deletes the earlier deltas and the page text they hold.
 */
export const PageReadsDoc = defineDoc<PageReads>({
	kind: "piaside.pageReads",
	version: 5,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ run: 0, calls: [], snapshots: [], tabs: [], tabsSession: null, tab: null }),
	// Version 1 counted reads only; version 2 had no tabs.
	migrate: (value, version) => {
		const { reads, ...rest } = value as { reads?: number[]; tabs?: number[]; tab?: number | null };
		// Resolve a known old ordinal without granting access. An unresolved old target must fail closed, not
		// silently route pending work to the attached tab. The next answer resets this selection as usual.
		const ordinal = rest.tab ?? 1;
		const tab =
			version >= 4
				? (rest.tab ?? null)
				: ordinal === 1
					? null
					: Number.isInteger(ordinal) && ordinal >= 2
						? (rest.tabs?.[ordinal - 2] ?? -1)
						: -1;
		// Older ownership has no browser-session stamp: never trust it after an upgrade or browser restart.
		return { run: 0, calls: reads ?? [], snapshots: [], ...rest, tabs: [], tabsSession: null, tab } as PageReads;
	},
	checkpointWhen: (value) => value.snapshots.length === 0,
});

/**
 * Counts call `taskId` of `run` once, so a rerun after a restart is not counted again; false when the run has made
 * `limit` calls. Starts the state over for a new run. Mutates `state` in a commit.
 */
export function reserveCall(state: PageReads, run: number, taskId: number, limit: number): boolean {
	if (state.run !== run) {
		state.run = run;
		state.calls = [];
		state.snapshots = [];
		state.tab = null;
	}
	if (state.calls.includes(taskId)) return true;
	if (state.calls.length >= limit) return false;
	state.calls.push(taskId);
	return true;
}

/** Whether the run has made `limit` calls, so a new call `taskId` would be refused. */
export function spent(state: PageReads | undefined, run: number, taskId: number, limit: number): boolean {
	return state !== undefined && state.run === run && !state.calls.includes(taskId) && state.calls.length >= limit;
}

/** The tab the page tools work on in run `run`: the attached page's, or one an action opened or switch_tab chose. */
export function workTab(state: PageReads | undefined, run: number, attached: number): number {
	return (state?.run === run ? state.tab : null) ?? attached;
}

export const limitText = (limit: number) => `The page tools were used ${limit} times in this answer; answer now.`;

export class PageRefused extends Error {}
/** Optional stable Chrome ID; an explicit target does not change the answer's selection. */
export const tabParameter = () =>
	Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Stable Chrome tab ID from list_tabs; default the answer-selected or attached tab.",
		}),
	);

/** Every browser send rechecks native scope, then synchronous policy and Stop, with no intervening await. */
export function scopedPageAccess(
	deps: PageDeps,
	anchor: number,
	target: number,
	tool: string,
	context: Context,
	policy: () => string | null = () => null,
) {
	let signal: AbortSignal | undefined;
	const finalCheck = (active: AbortSignal | undefined) => {
		context.abortSignal?.throwIfAborted();
		active?.throwIfAborted();
		const tools = deps.currentSettings().tools;
		const mode =
			tool === LIST_TABS
				? Object.values(tools).some((mode) => mode !== "off")
					? "on"
					: "off"
				: tools[
						tool === READ_PAGE || tool === WAIT_ON_PAGE
							? "read"
							: tool === OBSERVE_PAGE
								? "observe"
								: tool === ACT_ON_PAGE
									? "act"
									: tool === RUN_SCRIPT
										? "script"
										: "screenshot"
					];
		if (mode === "off") throw new PageRefused(offText(tool));
		const refused = policy();
		if (refused !== null) throw new PageRefused(refused);
	};
	const check = async () => {
		const active = signal;
		finalCheck(active);
		const members = await deps.groups
			.scope(anchor, () => finalCheck(active))
			.catch(() => {
				finalCheck(active);
				throw new ScopeDenied();
			});
		if (!members.some((tab) => tab.id === target)) throw new ScopeDenied();
		finalCheck(active);
		return members;
	};
	const wait: typeof bounded = (call, ctx, ms) =>
		bounded(
			async (next) => {
				const previous = signal;
				signal = next;
				try {
					return await call(next);
				} finally {
					signal = previous;
				}
			},
			ctx,
			ms,
		);
	const send = <T>(call: () => Promise<T>) => {
		const dispatch = async () => {
			const active = signal;
			await check();
			finalCheck(active);
			return call();
		};
		return signal === undefined ? wait(dispatch, context, deps.access.timeoutMs ?? PAGE_TIMEOUT_MS) : dispatch();
	};
	const a = deps.access;
	const access = {
		...a,
		check,
		frames: (tab: number) => send(() => a.frames(tab)),
		text: (tab: number, doc: string, chars: number, ms: number, scope?: ReadScope) =>
			send(() => a.text(tab, doc, chars, ms, scope)),
		current: (tab: number, doc: string) => send(() => a.current(tab, doc)),
		top: (tab: number) => send(() => a.top(tab)),
		observe: (tab: number, doc: string, request: ObserveRequest) => send(() => a.observe(tab, doc, request)),
		act: (tab: number, doc: string, request: ActRequest) => send(() => a.act(tab, doc, request)),
		navigate: (tab: number, doc: string, url: string) => send(() => a.navigate(tab, doc, url)),
		loaded: (tab: number, ms: number, signal: AbortSignal) => send(() => a.loaded(tab, ms, signal, send)),
		scriptWorld: () => send(() => a.scriptWorld()),
		script: (tab: number, doc: string, code: string, bytes: number) => send(() => a.script(tab, doc, code, bytes)),
		media: (tab: number, doc: string, key: string) => send(() => a.media(tab, doc, key)),
		locate: (tab: number, doc: string, request: LocateRequest) => send(() => a.locate(tab, doc, request)),
		scroll: (tab: number, doc: string, request: ScrollRequest) => send(() => a.scroll(tab, doc, request)),
		tabState: (tab: number) => send(() => a.tabState(tab, send)),
		capture: (window: number) => send(() => a.capture(window)),
		close: (tab: number) => send(() => a.close(tab)),
		switchBack: (tab: number, opened: readonly number[], window: number) =>
			send(() => {
				const active = signal;
				return a.switchBack(tab, opened, window, () => finalCheck(active), send);
			}),
	};
	return { access, wait };
}

/**
 * The run of the chat: the submission ID of its first input, as `run.taskId` changes with each generation round.
 * pi-durable tells runs apart by `inputs[0]` too; the page tool tests fail if it stops lasting a whole run.
 */
export async function runOf(reader: DocumentReader, conversationId: ConversationId, context: Context): Promise<number> {
	return Number((await reader.snapshot(LiveDoc, conversationId, context))?.run?.inputs[0] ?? 0);
}

export type Envelope = {
	/** Whole-page results omit this field. */
	scope?: "selection";
	url: string;
	title: string;
	snapshotId: number;
	offset: number;
	/** Where the next chunk starts; null at the end. */
	nextOffset: number | null;
	/** The page had more text than the snapshot keeps. */
	truncated: boolean;
	/** The tab navigated or closed since the snapshot was taken. */
	pageChanged?: true;
	text: string;
};

/**
 * The chunk at `offset` (in UTF-16 units; one inside a surrogate pair moves to its start), cut so that the envelope
 * stays within `MAX_RESULT_BYTES` and no surrogate pair is split. The snapshot text is well formed.
 */
export function envelope(snapshot: Snapshot, start: number, limit: number, pageChanged: boolean): Envelope {
	const encoder = new TextEncoder();
	const offset = start > 0 && isHighSurrogate(snapshot.text.charCodeAt(start - 1)) ? start - 1 : start;
	let end = Math.min(snapshot.text.length, offset + limit);
	for (;;) {
		// Never split a pair: back off, or take the whole pair when it is the only character left.
		if (end < snapshot.text.length && isHighSurrogate(snapshot.text.charCodeAt(end - 1))) {
			end = end - 1 > offset ? end - 1 : end + 1;
		}
		const result: Envelope = {
			...(snapshot.scope === "selection" ? { scope: "selection" as const } : {}),
			url: snapshot.url,
			title: snapshot.title,
			snapshotId: snapshot.id,
			offset,
			nextOffset: end < snapshot.text.length ? end : null,
			truncated: snapshot.truncated,
			...(pageChanged ? { pageChanged: true as const } : {}),
			text: snapshot.text.slice(offset, end),
		};
		const bytes = encoder.encode(JSON.stringify(result)).length;
		if (bytes <= MAX_RESULT_BYTES || end <= offset) return result;
		end = offset + Math.floor(((end - offset) * MAX_RESULT_BYTES * 0.95) / bytes);
	}
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** What a first read takes from the tab. */
export type TabRead = {
	documentId: string;
	url: string;
	title: string;
	text: string;
	truncated: boolean;
	changed: boolean;
};

/** The frames a read of a top-level page reads, or why it reads none. */
export type FramePlan = { top: FrameInfo; others: FrameInfo[]; left: number };

/**
 * Which frames to read for the attached top-level page (design 6.22): the tab's top frame, which must be on a site,
 * then the other frames on that origin that show, by frame ID, at most `MAX_FRAMES` in all; `left` counts the ones
 * over that. A string when the top frame is not readable.
 */
export function planFrames(frames: readonly FrameInfo[]): FramePlan | string {
	const top = frames.find((frame) => frame.frameId === 0);
	if (top === undefined) return `Cannot read the page: pi may not read the tab's page now. ${NO_ACCESS}`;
	if (top.origin === "null") return notSiteText(top);
	const others = frames
		.filter((frame) => frame.frameId !== 0 && frame.shown && frame.origin === top.origin)
		.toSorted((a, b) => a.frameId - b.frameId);
	return {
		top,
		others: others.slice(0, MAX_FRAMES - 1),
		left: Math.max(0, others.length - (MAX_FRAMES - 1)),
	};
}

/** A first read that found no time left for the top document. */
const SLOW = `Cannot read the page: the tab did not answer within ${READ_BUDGET_MS / 1000} s. Ask the user to ask again when the page has loaded.`;

/**
 * Reads `page` for a first read: the attached frame's document, or the tab's top-level page and its frames. Starts no
 * Chrome call after `signal` ends; one that runs may finish. `stopped` is asked right before each document's text is
 * read: a string ends the read with it.
 */
async function readTab(
	access: PageAccess,
	page: PageRef & { documentId: string },
	signal: AbortSignal,
	stopped: () => Promise<string | null>,
	scope: ReadScope,
): Promise<TabRead | string> {
	const now = () => access.now?.() ?? Date.now();
	// One budget for all readers: the top document's, a retry's, and the frames'.
	const deadline = now() + READ_BUDGET_MS;
	if (page.frameId !== 0) {
		// A selection in a frame: the document it came from, as captured (design 6.22).
		const stop = await stopped();
		if (stop !== null) return stop;
		signal.throwIfAborted();
		const read = await access.text(page.tabId, page.documentId, MAX_PAGE_CHARS, deadline - now(), scope);
		if (read === null) return "Cannot read the page: the page has no readable text.";
		return {
			documentId: page.documentId,
			url: read.url,
			title: read.title,
			text: read.text.toWellFormed(),
			truncated: !read.complete || read.length > read.text.length,
			changed: !samePage(read.url, page.url),
		};
	}
	// The top document found first is read by its ID, so a navigation in between does not mix two pages. If it is gone,
	// the read starts once more.
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		const plan = planFrames(await access.frames(page.tabId));
		if (typeof plan === "string") return plan;
		if (now() >= deadline) return SLOW;
		let top: FrameText | null;
		const stop = await stopped();
		if (stop !== null) return stop;
		try {
			signal.throwIfAborted();
			top = await access.text(page.tabId, plan.top.documentId, MAX_PAGE_CHARS, deadline - now(), scope);
		} catch (error) {
			signal.throwIfAborted();
			if (attempt === 0 && (await access.current(page.tabId, plan.top.documentId)) === null) continue;
			throw error;
		}
		if (top === null) return "Cannot read the page: the page has no readable text.";
		const parts = [top.text];
		let used = top.text.length;
		let truncated = !top.complete || top.length > top.text.length || plan.left > 0;
		// What fits after the separator and a frame's label.
		const room = (url: string) => MAX_PAGE_CHARS - used - 2 - frameLabel(url).length;
		for (const frame of plan.others) {
			if (room(frame.url) <= 0 || now() >= deadline) {
				truncated = true;
				break;
			}
			const stop = await stopped();
			if (stop !== null) return stop;
			signal.throwIfAborted();
			// A frame that went away, or that pi may no longer script, is left out.
			const read = await access
				.text(page.tabId, frame.documentId, room(frame.url), deadline - now(), scope)
				.catch(() => null);
			if (read === null) continue;
			// A reader out of time may have no text: what it left out is still missing.
			if (!read.complete) truncated = true;
			if (read.text.trim() === "") continue;
			// Labelled with the URL the reader saw, which may be longer: the frame's app may have moved on since the list.
			const fit = room(read.url);
			const kept = fit > 0 ? cut(read.text, fit) : "";
			if (kept === "") {
				truncated = true;
				break;
			}
			parts.push(`${frameLabel(read.url)}${kept}`);
			used += 2 + frameLabel(read.url).length + kept.length;
			if (read.length > kept.length) truncated = true;
		}
		return {
			documentId: plan.top.documentId,
			url: top.url,
			title: top.title,
			text: cut(parts.join("\n\n"), MAX_PAGE_CHARS).toWellFormed(),
			truncated,
			// By the URL read: a single-page app may have moved on since the frames were listed.
			changed: !samePage(top.url, page.url),
		};
	}
}

const frameLabel = (url: string) => `[Frame: ${url}]\n`;

export function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.origin === "null" ? null : parsed.origin;
	} catch {
		return null;
	}
}

/**
 * By URL key with the anchor unknown, as pages are matched to chats (6.17); URLs without a key as written. Both as
 * stored: the attached page's URL and a snapshot's are cut to `MAX_URL_CHARS`.
 */
export function samePage(a: string, b: string): boolean {
	const [one, two] = [a.slice(0, MAX_URL_CHARS), b.slice(0, MAX_URL_CHARS)];
	const key = urlKey(one, null);
	return key === null ? one === two : key === urlKey(two, null);
}

export const failure = (text: string, details?: JsonObject): ToolExecutionResult => ({
	output: [{ type: "text", text }],
	isError: true,
	...(details === undefined ? {} : { details }),
});

/**
 * The page of the newest input: the message the model is answering. Undefined when there is no input. Inputs only: a
 * compaction summary is a user message too, and newer than the input it keeps. `scan` gives the chat's entries, newest
 * first.
 */
export async function latestPage(
	scan: (cursor: Cursor | undefined) => Promise<Page<EntryRecord, Cursor>>,
): Promise<PageRef | null | undefined> {
	let cursor: Cursor | undefined;
	for (;;) {
		const scanned = await scan(cursor);
		for (const entry of scanned.items) if (INPUT_KINDS.has(entry.kind)) return pageOf(entry);
		if (scanned.next === undefined) return undefined;
		cursor = scanned.next;
	}
}

/** read_page's description, naming only the tools that are not Off (design 6.23). */
export function readPageDescription({ tools, callsPerAnswer }: PageToolSettings): string {
	const act = tools.act !== "off";
	const changers = [
		...(act ? [ACT_ON_PAGE] : []),
		...(tools.script !== "off" ? [RUN_SCRIPT] : []),
		...(tools.screenshot !== "off" ? [`a ${SCREENSHOT_PAGE} call that scrolled`] : []),
	];
	const media = [
		...(tools.observe !== "off" ? [`${OBSERVE_PAGE} gives their refs (find "image")`] : []),
		...(tools.screenshot !== "off" ? [`${SCREENSHOT_PAGE} shows them`] : []),
	];
	return `Reads the text of the web page attached to the user's latest message, as its tab shows it now: after a \
reload or a link, the page the tab shows. The text is what the page has drawn, with the text \
of its web components and of its frames from the same origin, each after a "[Frame: url]" line. Parts the page has \
not drawn are missing (collapsed sections, diffs not loaded, rows a list adds only when scrolled to), and so is text \
drawn on a canvas; ${act ? `open them with ${ACT_ON_PAGE} first` : "if the answer needs them, ask the user to expand or scroll the page and ask again"}. \
Images, diagrams, canvas, and video are a line of their own, with their name (an image's alt text, or "(no alt)"), \
their size in CSS pixels, and their figure's caption, such as [image "(no alt)" 400×360 caption "Sales by region"]; \
what they show is not in the text${media.length > 0 ? `: ${media.join(", and ")}` : ""}.\
${tools.screenshot !== "off" ? " When the answer is about the page's images, say which you did not look at." : ""} \
Default scope is "page": a selection does not change a whole-page read. Use scope "selection" only when the question \
concerns selected text not already in the message. It reads the currently selected body text, not form field values \
or media markers, with the same visibility and frame limits; no readable selection returns "No readable text is selected." \
The selection is read at tool execution, not when the message was sent. Each scope takes its own first snapshot; \
later calls in that scope read further in it: pass the previous result's nextOffset as offset. \
${changers.length > 0 ? `After ${changers.join(" or ")}, the next call takes a new snapshot: earlier offsets no longer apply, and reading starts again at 0. ` : ""}\
Result JSON: url, title, snapshotId, offset, nextOffset (null at the end), truncated (the snapshot does not hold all \
of the requested text), pageChanged (the tab shows another page than the one attached), scope ("selection" when requested), \
text. The page tools can be \
called ${callsPerAnswer} times per answer in all.`;
}

export const NO_ACCESS = `The tab may have closed, or Chrome's access from the click ended when the tab went to another \
site; ask the user to allow pi on all sites in Settings > Advanced > Sites, or to click the pi toolbar button on the page.`;

/** A wait on the page that passed its time. */
export class PageTimeout extends Error {}

/**
 * Waits for `call` until it settles, the tool is cancelled, or the timeout passes, and gives it the signal of both: it
 * starts no Chrome call after the wait ends, and does not call `call` once the tool is cancelled. A Chrome call
 * already sent may finish, and what it did is not undone; nothing is published after the wait ends.
 */
export async function bounded<T>(
	call: (signal: AbortSignal) => Promise<T>,
	context: Context,
	timeoutMs: number,
): Promise<T> {
	// Stopped already: nothing is sent, also by a call that does not look at its signal.
	context.abortSignal?.throwIfAborted();
	const timeout = AbortSignal.timeout(timeoutMs);
	const scope = withAbortSignal(timeout, context);
	const running = call(scope.abortSignal ?? timeout);
	// It rejects when it sees the signal, after the wait has ended.
	running.catch(() => {});
	try {
		return await awaitWithContext(running, scope);
	} catch (error) {
		if (timeout.aborted && !context.abortSignal?.aborted) {
			throw new PageTimeout(`the page did not answer within ${timeoutMs / 1000} s`);
		}
		throw error;
	}
}

/** read_page, described for `config`; each call reads the settings as they are then. */
export function readPageTool(deps: PageDeps, config: PageToolSettings): ToolRegistration {
	return defineTool({
		name: READ_PAGE,
		description: readPageDescription(config),
		parameters: Type.Object({
			tab: tabParameter(),
			scope: Type.Optional(
				Type.Union([Type.Literal("page"), Type.Literal("selection")], {
					description: "Read the whole page or selected text; default page.",
				}),
			),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset; default 0." })),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1000,
					maximum: MAX_LIMIT,
					description: `Characters to return; default ${DEFAULT_LIMIT}.`,
				}),
			),
		}),
		// Reading has no effect on the page, so a call that a restart interrupted runs again.
		replay: "safe",
		// One call at a time: the first one of a run takes the snapshot that later ones page through.
		executionMode: "sequential",
		outputLimits: { maxBytes: MAX_RESULT_BYTES + 1024 },
		async execute(args, api, context) {
			const { conversationId } = api;
			const { tools, callsPerAnswer } = await deps.settings();
			if (tools.read === "off") return failure(offText(READ_PAGE));
			const page = await api.commit(
				(tx) => latestPage((cursor) => tx.scanEntries({ conversationId, order: "descending" }, 20, cursor)),
				context,
			);
			if (page == null || page.documentId === null) return failure(NO_PAGE);
			const documentId = page.documentId;
			const run = await runOf(api, conversationId, context);
			const taskId = Number(api.taskId);
			const reserved = await api.commit(async (tx) => {
				const state = await tx.doc(PageReadsDoc, conversationId);
				if (!reserveCall(state, run, taskId, callsPerAnswer)) return "limit";
				return args.tab ?? workTab(state, run, page.tabId);
			}, context);
			if (reserved === "limit") return failure(limitText(callsPerAnswer));
			let currentDispatched = false;
			const currentAccess = {
				...deps.access,
				current(tabId: number, documentId: string) {
					currentDispatched = true;
					return deps.access.current(tabId, documentId);
				},
			};
			const { access, wait } = scopedPageAccess(
				{ ...deps, access: currentAccess },
				page.tabId,
				reserved,
				READ_PAGE,
				context,
			);
			try {
				await wait(() => access.check(), context, access.timeoutMs ?? PAGE_TIMEOUT_MS);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				return failure(String(error instanceof Error ? error.message : error));
			}
			// Another tab of the run (design 6.29): its top page, found by the tab instead of the attached document.
			const tabbed =
				reserved === page.tabId
					? { ...page, documentId }
					: { ...page, tabId: reserved, frameId: 0, documentId: `tab ${reserved}` };
			const scope = args.scope ?? "page";
			const found = (await api.snapshot(PageReadsDoc, conversationId, context))?.snapshots.find(
				(snapshot) => snapshot.documentId === tabbed.documentId && (snapshot.scope ?? "page") === scope,
			);
			const timeoutMs = access.timeoutMs ?? PAGE_TIMEOUT_MS;
			let snapshot = found === undefined ? undefined : { ...found };
			let pageChanged = false;
			if (snapshot === undefined) {
				// The mode as it is now: a read turned Off during the waits does not start reading the page.
				const stopped = async () => {
					const now = await deps.settings();
					return now.tools.read === "off" ? offText(READ_PAGE) : null;
				};
				let read: TabRead | string;
				try {
					read = await wait((signal) => readTab(access, tabbed, signal, stopped, scope), context, timeoutMs);
				} catch (error) {
					if (context.abortSignal?.aborted) throw error;
					// Chrome's messages end with a period ("No tab with id: 1.").
					const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
					return failure(`Cannot read the page: ${message}. ${NO_ACCESS}`);
				}
				if (typeof read === "string") return failure(read);
				if (scope === "selection" && read.text.trim() === "" && !read.truncated)
					return failure("No readable text is selected.");
				// Changed from the attached page; another tab's page was never attached (6.29).
				const changed = read.changed && reserved === page.tabId;
				const taken: Snapshot = {
					...(scope === "selection" ? { scope } : {}),
					id: taskId,
					documentId: tabbed.documentId,
					read: read.documentId,
					...(changed ? { pageChanged: true as const } : {}),
					url: read.url.slice(0, MAX_URL_CHARS),
					title: pageTitle(read.title),
					takenAt: access.now?.() ?? Date.now(),
					text: read.text,
					truncated: read.truncated,
				};
				// Published before any chunk is returned; a later call of this run pages through it.
				await api.commit(async (tx) => {
					const state = await tx.doc(PageReadsDoc, conversationId);
					if (state.run === run) state.snapshots.push(taken);
				}, context);
				snapshot = taken;
				pageChanged = changed;
			} else {
				// Changed: the document read is gone or has another URL (a single-page app moves on in one document). A page
				// that does not answer in time counts as changed.
				const read = snapshot.read ?? snapshot.documentId;
				let url: string | null;
				try {
					url = await wait(() => access.current(tabbed.tabId, read), context, timeoutMs);
				} catch (error) {
					if (context.abortSignal?.aborted) throw error;
					// Only an actual document-response failure may fall back to cached text. A timeout before
					// native current() dispatch means scope was not validated, so cached access is refused too.
					if (!currentDispatched || error instanceof ScopeDenied || error instanceof PageRefused)
						return failure(error instanceof Error ? error.message : String(error));
					url = null;
				}
				pageChanged = snapshot.pageChanged === true || url === null || !samePage(url, snapshot.url);
			}

			const offset = args.offset ?? 0;
			if (offset > snapshot.text.length) {
				return failure(`offset ${offset} is past the end of the page text (${snapshot.text.length} characters).`);
			}
			const result = envelope(snapshot, offset, args.limit ?? DEFAULT_LIMIT, pageChanged);
			const { text, ...details } = result;
			return {
				output: [{ type: "text", text: JSON.stringify(result) }],
				details: { ...details, length: text.length },
			};
		},
	});
}

export const NO_PAGE =
	"No readable page is attached to the user's latest message. Ask the user to open the page and click the pi toolbar button, or select text and choose Ask pi.";

/** A call of a tool that is Off: from a request made before the user turned it off. */
export const offText = (tool: string) => `${tool} is turned off in pi's settings; do not call it.`;

/**
 * Runs in each frame: where it is, and whether it shows (design 6.22). It shows when each `<iframe>` above it is visible
 * and at least 2 px wide and high. An `<iframe>` in a document of another origin cannot be checked (`frameElement` is
 * null there), so a frame under one does not count as showing. Self-contained: Chrome serializes it.
 */
function frameInfo(maxUrl: number): Omit<FrameInfo, "frameId" | "documentId"> {
	let shown = true;
	for (let at: Window = window; shown && at !== at.top; at = at.parent) {
		let owner: Element | null = null;
		try {
			owner = at.frameElement;
		} catch {
			owner = null;
		}
		const box = owner?.getBoundingClientRect();
		shown =
			owner !== null &&
			box !== undefined &&
			owner.checkVisibility({ visibilityProperty: true }) &&
			box.width >= 2 &&
			box.height >= 2;
	}
	return { url: location.href.slice(0, maxUrl), origin: self.origin, shown };
}

/**
 * Runs in one document: the text it has drawn (design 6.22), without form field values, scripts, or hidden text, read
 * for about `budgetMs`. Null for a document without a body (SVG, XML), whose other text is not drawn text.
 * Self-contained: Chrome serializes it.
 */
function readFrameText(maxChars: number, budgetMs: number, maxUrl: number, scope: ReadScope): FrameText | null {
	if (document.body === null) return null;
	const end = performance.now() + budgetMs;
	let complete = true;
	let steps = 0;
	const late = () => {
		if (complete && ++steps % 256 === 0 && performance.now() > end) complete = false;
		return !complete;
	};
	// Closed shadow roots too; `chrome.dom` is there in the extension's isolated world.
	const shadowOf = (element: Element): ShadowRoot | null =>
		element.shadowRoot ??
		(element instanceof HTMLElement ? (globalThis.chrome?.dom?.openOrClosedShadowRoot(element) ?? null) : null);
	// Media, which `innerText` leaves out, as a line of their own: `[image "alt" 312×387 caption "…"]`. Those that
	// observe_page lists, by its rules (page-agent.ts `mediaOf`, `decorative`, `MIN_MEDIA`, `nameOf`, `captionOf`):
	// keep the two in step.
	const clean = (text: string) => text.replace(/\s+/g, " ").trim();
	const short = (text: string) => {
		const one = clean(text);
		if (one.length <= 80) return one;
		const high = one.charCodeAt(78);
		return `${one.slice(0, high >= 0xd800 && high <= 0xdbff ? 78 : 79)}…`;
	};
	/** Never read: scripts, styles, and fields, whose content is no drawn text. */
	const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT"]);
	/**
	 * The text in `root` for a marker, at most a few hundred characters, by the reader's rules: no scripts or fields,
	 * and with `drawn`, nothing the page does not draw. Not `innerText`, which of an element the page does not draw is
	 * all of its text, its scripts and fields included. A name may come from a hidden element, as `aria-labelledby`
	 * allows.
	 */
	const textIn = (root: Element, drawn: boolean): string => {
		if (drawn && !root.checkVisibility({ visibilityProperty: true })) return "";
		let out = "";
		const visit = (node: Node, shown: boolean) => {
			if (out.length > 400) return;
			if (node.nodeType === Node.TEXT_NODE) {
				if (shown) out += (node as Text).data;
				return;
			}
			if (!(node instanceof Element) || skip.has(node.tagName)) return;
			const style = getComputedStyle(node);
			if (drawn && style.display === "none") return;
			const block = style.display !== "contents" && !style.display.startsWith("inline");
			if (block) out += " ";
			for (const child of node.childNodes) visit(child, !drawn || style.visibility === "visible");
			if (block) out += " ";
		};
		visit(root, true);
		return out;
	};
	const kindOf = (element: Element): string | null => {
		const role = (element.getAttribute("role") ?? "").trim().split(/\s+/)[0]!.toLowerCase();
		if (element.tagName === "IMG" || role === "img") return "image";
		if (element instanceof SVGSVGElement && element.ownerSVGElement === null) return "graphic";
		if (element.tagName === "CANVAS") return "canvas";
		if (element.tagName === "VIDEO") return "video";
		return null;
	};
	const marker = (element: Element, kind: string, box: DOMRect): string => {
		const ids = clean(element.getAttribute("aria-labelledby") ?? "").split(" ");
		const labelled = ids
			.map((id) => {
				const by = id === "" ? null : document.getElementById(id);
				return by === null ? "" : textIn(by, false);
			})
			.join(" ");
		const title = [...element.children].find((child) => child.tagName.toLowerCase() === "title");
		const name = short(
			[
				element.getAttribute("aria-label") ?? "",
				labelled,
				element.getAttribute("alt") ?? "",
				element instanceof SVGSVGElement ? (title?.textContent ?? "") : "",
				element.getAttribute("title") ?? "",
			].find((one) => clean(one) !== "") ?? "",
		);
		const figure = element.parentElement?.closest("figure");
		const figcaption = [...(figure?.children ?? [])].find((child) => child.tagName === "FIGCAPTION");
		// Only as drawn: a caption the page hides is no drawn text.
		const caption = figcaption === undefined ? "" : short(textIn(figcaption, true));
		const parts = [
			kind,
			...(name !== "" ? [JSON.stringify(name)] : kind === "image" ? ['"(no alt)"'] : []),
			`${Math.round(box.width)}×${Math.round(box.height)}`,
			...(caption !== "" ? [`caption ${JSON.stringify(caption)}`] : []),
		];
		return `[${parts.join(" ")}]`;
	};
	// Media to mark: at least 48 px on both sides, and not `role="presentation"` or `"none"`, or under
	// `aria-hidden="true"`.
	const media = new Map<Element, string>();
	const medium = (element: Element) => {
		const kind = kindOf(element);
		if (kind === null || /^(presentation|none)$/i.test(clean(element.getAttribute("role") ?? ""))) return;
		if (element.closest('[aria-hidden="true"]') !== null) return;
		const box = element.getBoundingClientRect();
		if (box.width >= 48 && box.height >= 48) media.set(element, marker(element, kind, box));
	};
	// The elements on the way to a shadow host, a slot, a `<select>`, or a medium are walked; any other subtree that
	// the page draws is read with `innerText`, which would have each option of a select, chosen or not.
	const walked = new Set<Element>();
	const mark = (element: Element) => {
		for (let at: Node | null = element; at !== null && !walked.has(at as Element); ) {
			if (at instanceof Element) walked.add(at);
			at = at instanceof ShadowRoot ? at.host : at.parentNode;
		}
	};
	const scan = (root: Node) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
		// The root too: `nextNode()` starts below it, and `body` may host a shadow root.
		for (let node: Node | null = root; node !== null && !late(); node = walker.nextNode()) {
			if (!(node instanceof Element)) continue;
			const shadow = shadowOf(node);
			if (shadow !== null) {
				mark(node);
				scan(shadow);
			}
			if (node instanceof HTMLSlotElement && node.getRootNode() instanceof ShadowRoot) mark(node);
			if (node.tagName === "SELECT") mark(node);
			medium(node);
			if (media.has(node)) mark(node);
		}
	};
	// Selection boundaries and text nodes must share one order, including slots and shadow trees. Do not use
	// Selection.toString(): it can include hidden text and textarea contents, outside the reader's privacy rules.
	const positions = new Map<Node, { before: number; after: number }>();
	let selected: { start: number; end: number } | undefined;
	if (scope === "selection") {
		const empty: FrameText = {
			url: location.href.slice(0, maxUrl),
			title: document.title.slice(0, maxUrl),
			text: "",
			length: 0,
			complete: true,
		};
		const selection = window.getSelection();
		// isCollapsed can describe the legacy re-scoped range, not a backwards cross-shadow selection.
		if (selection === null || selection.rangeCount === 0) return empty;
		const activeIn = (doc: Document): Element | null => {
			let active = doc.activeElement;
			for (;;) {
				const root =
					active?.shadowRoot ??
					(active?.namespaceURI !== "http://www.w3.org/1999/xhtml"
						? null
						: globalThis.chrome?.dom?.openOrClosedShadowRoot(active as HTMLElement));
				if (root?.activeElement == null) return active;
				active = root.activeElement;
			}
		};
		// Focus stays on the last page element when the panel takes keyboard focus. Ignore stale selections in
		// other frames, and never substitute a stale body range for a selection in a form control.
		const active = activeIn(document);
		if (active !== null && ["IFRAME", "FRAME", "INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return empty;
		for (let at: Window = window; at !== at.top; at = at.parent) {
			const owner = at.frameElement;
			if (owner === null || activeIn(owner.ownerDocument) !== owner) return empty;
		}
		const roots: ShadowRoot[] = [];
		let position = 0;
		const index = (node: Node) => {
			if (late()) return;
			const before = position++;
			if (node.nodeType === Node.TEXT_NODE) position += (node as Text).length;
			else {
				const shadow = node instanceof Element ? shadowOf(node) : null;
				if (shadow !== null) roots.push(shadow);
				const children =
					shadow !== null
						? [shadow]
						: node instanceof HTMLSlotElement
							? node.assignedNodes({ flatten: true })
							: node.childNodes;
				for (const child of children) index(child);
			}
			positions.set(node, { before, after: position++ });
		};
		index(document);
		const boundary = (node: Node, offset: number): number | undefined => {
			const span = positions.get(node);
			if (span === undefined) return undefined;
			if (node.nodeType === Node.TEXT_NODE) return span.before + 1 + offset;
			if (node.childNodes.length === 0) return span.before + 1;
			if (offset < node.childNodes.length) return positions.get(node.childNodes[offset]!)?.before;
			const last = positions.get(node.childNodes[offset - 1]!);
			return last === undefined ? undefined : last.after + 1;
		};
		const range = selection.getComposedRanges({ shadowRoots: roots })[0];
		if (range !== undefined) {
			const start = boundary(range.startContainer, range.startOffset);
			const end = boundary(range.endContainer, range.endOffset);
			if (start !== undefined && end !== undefined && start < end) selected = { start, end };
		}
	} else scan(document.body);
	// Text, and null for a line break between blocks; a run of them is one.
	const out: (string | null)[] = [];
	const styles = new Map<Element, CSSStyleDeclaration>();
	const style = (element: Element) => {
		let found = styles.get(element);
		if (found === undefined) {
			found = getComputedStyle(element);
			styles.set(element, found);
		}
		return found;
	};
	// As `innerText` does: text under `visibility: hidden` is left out, though a visible child shows; white space is
	// kept as the element's `white-space-collapse` says, so code in a slotted `<pre>` keeps its lines.
	const walk = (node: Node, parent: Element) => {
		if (late()) return;
		if (node.nodeType === Node.TEXT_NODE) {
			const { visibility, whiteSpaceCollapse } = style(parent);
			if (visibility !== "visible") return;
			let data = (node as Text).data;
			if (scope === "selection") {
				const at = positions.get(node)?.before;
				if (selected === undefined || at === undefined) return;
				const start = Math.max(0, selected.start - at - 1);
				const end = Math.min(data.length, selected.end - at - 1);
				if (start >= end) return;
				data = data.slice(start, end);
			}
			if (whiteSpaceCollapse === "collapse") {
				data = data.replace(/[\t\n\r ]+/g, " ");
				// No space at the start of a line, or after another one.
				const before = out.at(-1);
				if (before == null || /(^|[ \n])$/.test(before)) data = data.replace(/^ /, "");
			} else if (whiteSpaceCollapse === "preserve-breaks") data = data.replace(/[\t ]+/g, " ");
			out.push(data);
			return;
		}
		const shown = node instanceof Element ? media.get(node) : undefined;
		if (shown !== undefined) {
			const element = node as Element;
			if (element.checkVisibility() && style(element).visibility === "visible") out.push(null, shown, null);
			return;
		}
		if (!(node instanceof HTMLElement) || skip.has(node.tagName)) return;
		if (node.tagName === "BR") {
			out.push("\n");
			return;
		}
		const { display } = style(node);
		// A slot, or any element with `display: contents`, has no box of its own, and its children may still show.
		if (display === "none" || (display !== "contents" && !node.checkVisibility())) return;
		const cell = display === "table-cell";
		const block = !cell && display !== "contents" && !display.startsWith("inline");
		if (block) out.push(null);
		// `innerText` of an element without a box is its raw text, so such an element is walked.
		// biome-ignore lint/performance/useDomNodeTextContent: Read rendered text, excluding hidden descendants.
		if (scope === "page" && !walked.has(node) && display !== "contents") out.push(node.innerText);
		else {
			const shadow = shadowOf(node);
			const children =
				shadow !== null
					? shadow.childNodes
					: node instanceof HTMLSlotElement
						? node.assignedNodes({ flatten: true })
						: node.childNodes;
			for (const child of children) walk(child, node);
		}
		if (cell) out.push("\t");
		else if (block) out.push(null);
	};
	// Walked from `body` also without a shadow root: `innerText` of an element the page does not draw, as a hidden
	// `body`, is all of its text, its scripts' included.
	walk(document.body, document.body);
	let drawn = "";
	let broken = false;
	for (const piece of out) {
		if (piece === null) broken = true;
		else if (!broken) drawn += piece;
		else if (/\S/.test(piece)) {
			// White space between breaks goes; what follows the last one stays, as a `<pre>`'s indent.
			drawn = drawn.replace(/[ \t]+$/, "");
			if (drawn !== "" && !drawn.endsWith("\n")) drawn += "\n";
			drawn += piece;
			broken = false;
		}
	}
	const text = drawn
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const high = text.charCodeAt(maxChars - 1);
	const cutAt = maxChars < text.length && high >= 0xd800 && high <= 0xdbff ? maxChars - 1 : maxChars;
	return {
		url: location.href.slice(0, maxUrl),
		title: document.title.slice(0, maxUrl),
		text: text.slice(0, cutAt),
		length: text.length,
		complete,
	};
}

/**
 * Runs in the tab's top frame: where it is. Self-contained: Chrome serializes it. It also leaves a watcher for where the
 * page sends the tab next, by a link, a form, or its own script, while pi may still script it: Chrome does not tell pi
 * the URL once the tab is on a site pi may not script, and a site card names it (design 6.28). The address bar and
 * bookmarks do not go through the page.
 */
function topInfo(maxUrl: number): Omit<TopDocument, "documentId"> {
	const world = globalThis as { piLeads?: boolean };
	if (!world.piLeads && typeof navigation !== "undefined" && typeof chrome !== "undefined") {
		world.piLeads = true;
		navigation.addEventListener("navigate", (event) => {
			if (event.destination.sameDocument || event.downloadRequest !== null) return;
			void chrome.runtime.sendMessage({ type: "pi-link", url: event.destination.url }).catch(() => {});
		});
	}
	// As the capture checks it (`readFrame`): a fragment that names an element is a place in the page.
	const fragment = new URL(location.href).hash.slice(1);
	let anchor: boolean | null = null;
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
	return { url: location.href.slice(0, maxUrl), origin: self.origin, title: document.title.slice(0, 300), anchor };
}

/** By tab: the site pi last saw the tab sent to (design 6.28), which a site card names when Chrome does not let pi in. */
const leads = new Map<number, string>();
/** By tab pi noted opening (design 6.29): the tab it came from, whose lead names it until it has its own. */
const openers = new Map<number, number>();
/** Tabs whose page pi left the watcher in (`topInfo`): it follows them to each page pi may script. */
const watched = new Set<number>();

/**
 * Notes that tab `tabId` goes to `url`: by a link pi clicks there, a URL it loads, or the page's own move. Each comes
 * from a page pi scripted, so the tab is watched, also by a worker that started after pi left the watcher there.
 */
export function noteLead(tabId: number, url: string): void {
	watched.add(tabId);
	const origin = siteOrigin(url);
	if (origin === null) leads.delete(tabId);
	else leads.set(tabId, origin);
}

/**
 * After each load of a watched tab, pi leaves the watcher in the new page if it may script it, and the tab's lead is
 * done: a page the user later leaves by the address bar is not named by it. A page pi may not script keeps the lead:
 * it is the site the last page pi could watch sent the tab to. With all sites allowed, no site card shows.
 */
export function watchLeads(): void {
	chrome.tabs.onUpdated.addListener((tabId, change) => {
		if (change.status !== "complete" || !watched.has(tabId)) return;
		void chrome.permissions
			.contains({ origins: ["<all_urls>"] })
			.then(async (all) => {
				if (all) return;
				if ((await chromePageAccess.top(tabId)) !== null) leads.delete(tabId);
			})
			.catch(() => {});
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		leads.delete(tabId);
		openers.delete(tabId);
		watched.delete(tabId);
	});
}

/** How long a send waits to learn where the tab is; after it, the message goes without a note. */
export const MOVE_TIMEOUT_MS = 1000;

/**
 * Where the tab of `page` is when a message about it is sent, if it no longer shows it (design 6.28). Undefined while it
 * shows the page, for a page attached in a frame, and when the tab does not answer in time.
 */
export async function pageMove(
	page: PageRef,
	access: Pick<PageAccess, "top" | "leadsTo"> = chromePageAccess,
): Promise<PageMove | undefined> {
	if (page.frameId !== 0) return undefined;
	let top: TopDocument | null;
	try {
		top = await bounded(() => access.top(page.tabId), BACKGROUND_CONTEXT, MOVE_TIMEOUT_MS);
	} catch {
		return undefined;
	}
	if (top === null) return { site: access.leadsTo(page.tabId) };
	// A place in the same document, such as a section's link, is the same page; another fragment that names no element
	// is the app's state, such as a route (`#/article/B`): another page.
	const place = (url: string) => url.split("#")[0];
	if (
		samePage(top.url, page.url) ||
		(top.anchor === true && top.documentId === page.documentId && place(top.url) === place(page.url))
	)
		return undefined;
	return { url: top.url.slice(0, MAX_URL_CHARS), title: pageTitle(top.title) };
}

export const chromePageAccess: PageAccess = {
	async frames(tabId) {
		const injections = await chrome.scripting.executeScript({
			target: { tabId, allFrames: true },
			func: frameInfo,
			args: [MAX_URL_CHARS],
		});
		return injections.flatMap(({ frameId, documentId, result }) =>
			result == null ? [] : [{ ...result, frameId, documentId }],
		);
	},
	async text(tabId, documentId, maxChars, budgetMs, scope = "page") {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: readFrameText,
			args: [maxChars, budgetMs, MAX_URL_CHARS, scope],
		});
		return injection?.result ?? null;
	},
	async current(tabId, documentId) {
		try {
			const [injection] = await chrome.scripting.executeScript({
				target: { tabId, documentIds: [documentId] },
				func: (maxUrl: number) => location.href.slice(0, maxUrl),
				args: [MAX_URL_CHARS],
			});
			return injection?.result ?? null;
		} catch {
			return null;
		}
	},
	async top(tabId) {
		try {
			const [injection] = await chrome.scripting.executeScript({
				target: { tabId, frameIds: [0] },
				func: topInfo,
				args: [MAX_URL_CHARS],
			});
			if (injection?.result == null) return null;
			watched.add(tabId);
			return { ...injection.result, documentId: injection.documentId };
		} catch {
			return null;
		}
	},
	async observe(tabId, documentId, request) {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: pageAgent,
			args: [request],
		});
		return (injection?.result as ObserveResult | undefined) ?? null;
	},
	async act(tabId, documentId, request) {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: pageAgent,
			args: [request],
		});
		return (injection?.result as ActResult | undefined) ?? null;
	},
	async navigate(tabId, documentId, url) {
		const sent = chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: (to: string) => {
				if (to === "reload") location.reload();
				else location.assign(to);
			},
			args: [url],
		});
		if (url !== "reload") noteLead(tabId, url);
		await sent;
	},
	async loaded(tabId, ms, signal, dispatch = (request) => request()) {
		const deadline = Date.now() + ms;
		for (;;) {
			signal.throwIfAborted();
			if ((await dispatch(() => chrome.tabs.get(tabId))).status !== "loading") return true;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	},
	scripts: userScriptsAllowed,
	// Set before each script: the API is gone while the switch is off, so the worker's start may not have it. A world
	// already running in a document keeps the settings it started with, which are these.
	scriptWorld: () => chrome.userScripts.configureWorld({ worldId: SCRIPT_WORLD, csp: SCRIPT_CSP, messaging: false }),
	async script(tabId, documentId, code, maxBytes) {
		const [injection] = await chrome.userScripts.execute({
			target: { tabId, documentIds: [documentId] },
			js: [{ code: `(${runScript.toString()})(${JSON.stringify(code)}, ${maxBytes})` }],
			world: "USER_SCRIPT",
			worldId: SCRIPT_WORLD,
			injectImmediately: true,
		});
		if (injection?.error !== undefined) throw new Error(injection.error);
		return typeof injection?.result === "string" ? injection.result : null;
	},
	async media(tabId, documentId, key) {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: mediaState,
			args: [key, MAX_URL_CHARS],
		});
		return (injection?.result as MediaState | undefined) ?? null;
	},
	async locate(tabId, documentId, request) {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: pageAgent,
			args: [request],
		});
		return (injection?.result as LocateResult | undefined) ?? null;
	},
	async scroll(tabId, documentId, request) {
		const [injection] = await chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			func: pageAgent,
			args: [request],
		});
		return (injection?.result as ScrollResult | undefined) ?? null;
	},
	async tabState(tabId, dispatch = (request) => request()) {
		try {
			const tab = await dispatch(() => chrome.tabs.get(tabId));
			const window = await dispatch(() => chrome.windows.get(tab.windowId));
			return {
				windowId: tab.windowId,
				active: tab.active,
				minimized: window.state === "minimized",
				focused: window.focused,
			};
		} catch (error) {
			if (error instanceof ScopeDenied || error instanceof PageRefused) throw error;
			return null;
		}
	},
	allSites: () => chrome.permissions.contains({ origins: ["<all_urls>"] }),
	// Read when the card shows: the link's report and Chrome's new tab may arrive in either order.
	leadsTo(tabId) {
		const opener = openers.get(tabId);
		return leads.get(tabId) ?? (opener === undefined ? undefined : leads.get(opener)) ?? null;
	},
	changes: tabChangeCount,
	watch: watchTab,
	async close(tabId) {
		try {
			await chrome.tabs.remove(tabId);
			leads.delete(tabId);
			openers.delete(tabId);
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("No tab with id")) return false;
			throw error;
		}
	},
	async switchBack(tabId, opened, windowId, check = () => {}, dispatch = (request) => request()) {
		const attached = await dispatch(() => chrome.tabs.get(tabId));
		if (attached.windowId !== windowId) return null;
		const [front] = await dispatch(() => chrome.tabs.query({ active: true, windowId }));
		if (front?.id === undefined || front.windowId !== windowId || !opened.includes(front.id)) return null;
		// No await between the last foreground check, synchronous policy/Stop check, and activation.
		check();
		await chrome.tabs.update(tabId, { active: true });
		return front.id;
	},
	opened(tabId) {
		const tabs: number[] = [];
		// A link with target _blank or window.open: Chrome names the tab it came from, also for a new window.
		const noted = (tab: chrome.tabs.Tab) => {
			if (tab.openerTabId !== tabId || tab.id === undefined) return;
			tabs.push(tab.id);
			openers.set(tab.id, tabId);
		};
		chrome.tabs.onCreated.addListener(noted);
		return () => {
			chrome.tabs.onCreated.removeListener(noted);
			return tabs;
		};
	},
	capture: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
	async encode(png, crop, longSide, quality) {
		const bitmap = await createImageBitmap(new Blob([dataBytes(png)], { type: "image/png" }));
		try {
			const area =
				crop === null
					? { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
					: imageRect(crop, bitmap.width, bitmap.height);
			const scale = Math.min(1, longSide / Math.max(area.width, area.height));
			const width = Math.max(1, Math.round(area.width * scale));
			const height = Math.max(1, Math.round(area.height * scale));
			const canvas = new OffscreenCanvas(width, height);
			const drawing = canvas.getContext("2d");
			if (drawing === null) throw new Error("Chrome gave no canvas to draw the image on");
			drawing.imageSmoothingQuality = "high";
			drawing.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, width, height);
			const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality });
			return { data: base64(new Uint8Array(await jpeg.arrayBuffer())), width, height };
		} finally {
			bitmap.close();
		}
	},
};

/** pi's own script world (design 6.23): it sees the page's DOM, not the page's objects, and has no extension APIs. */
const SCRIPT_WORLD = "pi";
/** `new AsyncFunction(code)` needs eval; requests are not limited (design 6.23). */
const SCRIPT_CSP = "script-src 'self' 'unsafe-eval'";
