import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ModelThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	defineDoc,
	type EntryId,
	type EntryRecord,
	type Harness,
	type HarnessSettings,
	InboxDoc,
	type InputEntry,
	type JsonObject,
	LiveDoc,
	type LiveState,
	type ModelRef,
	type SubmissionId,
	type TaskGraph,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import { type AttachmentBlock, storedAttachments, withAttachments } from "../shared/attachments.ts";
import { t } from "../shared/i18n.ts";
import { MAX_IMAGE_BYTES } from "../shared/images.ts";
import {
	type AttachmentInfo,
	type ChatEntry,
	type ChatSummary,
	type ChatView,
	MAX_CHAT_TITLE,
	MAX_URL_CHARS,
	type MessageData,
	type PageMove,
	type PageRef,
	pageTitle,
	type SelectionEntryData,
	type StoredImage,
	type WhenBusy,
} from "../shared/protocol.ts";
import { draftEdited } from "./drafts.ts";
import { PageReadsDoc } from "./page.ts";
import {
	contentText,
	type Earlier,
	EMPTY_CHAT,
	INPUT_KIND,
	INPUT_KINDS,
	inputData,
	inputTitle,
	MESSAGE_KIND,
	pageOf,
	projectChat,
	projectEarlier,
	queuedInputs,
	SELECTION_KIND,
} from "./projection.ts";
import { chatImages, imagesIn } from "./screenshot.ts";
import type { Tabs } from "./tabs.ts";

const context = BACKGROUND_CONTEXT;
/** Chats the history lists besides the running ones, newest first. */
const MAX_LISTED = 50;

type IndexedChat = {
	id: number;
	createdAt: number;
	/** The request ID of the send that created the chat, so a resend from a fresh tab finds it. */
	request: string | null;
	/** The URL key of the page of the chat's first input; null without one. Rule 2 finds the chat by it. */
	key: string | null;
	/** The title the user gave it in History, in place of its first input's. */
	title?: string;
	/** Removed from History: not listed, opened, or continued by its page (design 6.30). */
	removed?: boolean;
	/** The chat Edit made this one from (design 6.34). */
	from?: number;
};

/**
 * Whether `chat` is chat `target`; with `createdAt`, from a History row, only the chat that row listed: after Delete
 * all, a fresh database numbers chats from 1 again, so a new chat can have an old row's ID.
 */
function isChat(chat: IndexedChat, target: number, createdAt: number | undefined): boolean {
	return chat.id === target && (createdAt === undefined || chat.createdAt === createdAt);
}

/** Every chat this extension created, in creation order. Written in each chat's creating commit. */
export const ChatsDoc = defineDoc<{ chats: IndexedChat[] }>({
	kind: "piaside.chats",
	version: 2,
	scope: "session",
	initial: () => ({ chats: [] }),
	// A full copy every 50 changes bounds what an open replays.
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
	// Version 1 had one `active` chat for all panels, and no keys: its chats stay in History, and no page continues them.
	migrate: (value: JsonObject) => ({
		chats: (value.chats as Omit<IndexedChat, "key">[]).map(({ id, createdAt, request }) => ({
			id,
			createdAt,
			request,
			key: null,
		})),
	}),
});

/** A command carried a `rev` the tab no longer has: New chat or History changed its chat since. */
export class TabChanged extends Error {
	constructor(what = t("nothingSent")) {
		super(t("tabChatChanged", [what]));
	}
}

/** Runs commands one at a time, in the order they arrive. */
export type Serial = <T>(operation: () => Promise<T>) => Promise<T>;

export function serial(): Serial {
	let line: Promise<unknown> = Promise.resolve();
	return <T>(operation: () => Promise<T>): Promise<T> => {
		const result = line.then(operation);
		line = result.catch(() => {});
		return result;
	};
}

export type ChatsOptions = {
	/** Shared with the tab lifecycle commands of the worker. */
	serial: Serial;
	tabs: Tabs;
	/** Whether the tab exists now. */
	tabOpen(tabId: number): Promise<boolean>;
	/** The IDs of the open tabs. */
	openTabs(): Promise<ReadonlySet<number>>;
	/** Runs a submit or abort with the recovery alarm armed before its commit. */
	admit<T>(operation: () => Promise<T>): Promise<T>;
	/** Rejects with the reason `model` cannot be used now: unknown, no key, no host permission. */
	check(model: ModelRef): Promise<void>;
	/** How many images a request of `model` may carry; null when it cannot read images (design 6.42). */
	imageLimit(model: ModelRef): Promise<number | null>;
	/** The model of a new chat. */
	defaultModel(): Promise<ModelRef>;
	setDefaultModel(model: ModelRef): Promise<void>;
	/** The thinking level of the next answer on `model`: the setting, fitted to the levels the model has (design 6.35). */
	thinking(model: ModelRef): Promise<ModelThinkingLevel>;
	/** Where the tab of `page` is, if it no longer shows it: an edited message says so as a sent one does (design 6.28). */
	moved?(page: PageRef): Promise<PageMove | undefined>;
	changed(): void;
	now?: () => number;
};

/** The Harness's queue settings: steers typed in a burst reach the model together, at the next tool round (design 6.39). */
export const QUEUE_SETTINGS = { steeringMode: "all" } as const satisfies HarnessSettings;

/** `whenBusy`: how the input queues while the chat runs or has queued inputs; default `followUp` (design 6.39). */
export type Input = { requestId: string; content: UserInput; entry?: InputEntry; whenBusy?: WhenBusy };

/**
 * A chat that a connected page shows. `earlier`: the projected entries before its active context, and where it starts.
 * `from`: the listed chat it was edited from, as it was when the view attached.
 */
type Watched = {
	view: AttachedReplicatedState<ConversationView>;
	earlier: { head: number | undefined } & Earlier;
	from: number | null;
	chat: ChatView;
	/**
	 * The running run, by its first input, and when this worker first saw it. Not by its task: pi-durable hands the run
	 * to a new task after each tool round, and the inputs move with it. Not by all its inputs: a steer joins the run and
	 * adds one (design 6.39), which must not restart its time.
	 */
	run?: { first: string; startedAt: number };
};

/**
 * The chats, which tab holds which (design 6.17), and the projections of the chats that pages show. Chats answer at
 * the same time; their commands do not. Lookups, sends, Retry, Stop, model changes, New chat, and History run one at a
 * time on the shared queue, each held until its admission or the end of its stop, never while an answer streams: the
 * model is a setting of the chat that each generation reads when it starts, and Stop must also stop the sends made
 * before it.
 *
 * A command names the tab and the `rev` its sender saw; another `rev` rejects it with `TabChanged`, after a resend
 * found its admission.
 */
export class Chats {
	readonly #harness: Harness;
	readonly #options: ChatsOptions;
	readonly #tabs: Tabs;
	readonly #serial: Serial;
	readonly #views = new Map<number, Watched>();
	readonly #attaching = new Map<number, Promise<Watched>>();
	/** Chats whose view is attaching though no page shows them any more: disposed when it is ready. */
	readonly #unwanted = new Set<number>();
	#graph: AttachedReplicatedState<TaskGraph> | undefined;
	/** The chats with a live task that can run: an answer, a tool, or a summary. */
	#running: ReadonlySet<number> = new Set();

	constructor(harness: Harness, options: ChatsOptions) {
		this.#harness = harness;
		this.#options = options;
		this.#tabs = options.tabs;
		this.#serial = options.serial;
	}

	/** Follows the task graph for the running chats; the first send of a tab creates its chat. */
	static async open(harness: Harness, options: ChatsOptions): Promise<Chats> {
		const chats = new Chats(harness, options);
		const graph = await harness.taskGraph(context);
		chats.#graph = graph;
		chats.#running = chats.#runningIn(graph.value);
		graph.subscribe((value) => {
			const running = chats.#runningIn(value);
			// A chat whose work ended may no longer need its page snapshots.
			for (const id of chats.#running) if (!running.has(id)) void chats.release(id).catch(() => {});
			chats.#running = running;
		});
		return chats;
	}

	/** The projection of chat `id`, if a page shows it and its view is attached. */
	view(id: number): ChatView | undefined {
		return this.#views.get(id)?.chat;
	}

	/** Keeps the views of chats `ids`, attaching the missing ones, and drops the others, also those still attaching. */
	retain(ids: ReadonlySet<number>): void {
		for (const [id, watched] of this.#views) {
			if (ids.has(id)) continue;
			watched.view.dispose();
			this.#views.delete(id);
		}
		for (const id of this.#attaching.keys()) if (!ids.has(id)) this.#unwanted.add(id);
		for (const id of ids) if (!this.#views.has(id)) void this.#attach(id).catch(() => {});
	}

	/** Attaches the view of chat `id`, if it is not. */
	async attach(id: number): Promise<void> {
		await this.#attach(id);
	}

	/** Each call wants the view, until the next `retain` without it. */
	#attach(id: number): Promise<Watched> {
		this.#unwanted.delete(id);
		const found = this.#views.get(id);
		if (found !== undefined) return Promise.resolve(found);
		let attaching = this.#attaching.get(id);
		if (attaching === undefined) {
			attaching = (async () => {
				const view = await (await this.#conversation(id)).viewState(context);
				const index = (await this.#harness.snapshot(ChatsDoc, context))?.chats ?? [];
				const from = index.find((chat) => chat.id === id)?.from;
				const watched: Watched = {
					view,
					earlier: { head: undefined, entries: [], cacheHit: undefined },
					from: index.some((chat) => chat.id === from && !chat.removed) ? (from ?? null) : null,
					chat: EMPTY_CHAT,
				};
				if (this.#unwanted.delete(id)) {
					// Its last page left meanwhile, and nothing would drop it later.
					view.dispose();
					return watched;
				}
				this.#project(watched, view.value);
				view.subscribe((value) => {
					if (this.#views.get(id) !== watched) return;
					this.#project(watched, value);
					this.#options.changed();
				});
				this.#views.set(id, watched);
				this.#options.changed();
				return watched;
			})().finally(() => this.#attaching.delete(id));
			this.#attaching.set(id, attaching);
		}
		return attaching;
	}

	/**
	 * Rule 2: an unresolved tab gets the newest chat that started on a page with `key`, or starts fresh. Does nothing to
	 * a tab that is resolved, or that has no entry: its gesture recorded nothing, or it was closed.
	 */
	lookup(tabId: number, key: string | null): Promise<void> {
		return this.#serial(async () => {
			await this.#tabs.load();
			const tab = this.#tabs.get(tabId);
			if (tab === undefined || tab.chat !== undefined) return;
			const index = await this.#harness.snapshot(ChatsDoc, context);
			const found = key === null ? undefined : index?.chats.findLast((chat) => chat.key === key && !chat.removed);
			if (found !== undefined) await this.attach(found.id);
			await this.#tabs.update((entries) => {
				const entry = entries.get(tabId);
				if (entry === undefined || entry.chat !== undefined) return;
				entries.set(tabId, { ...entry, chat: found?.id ?? null, resumed: found?.createdAt ?? null });
			});
		});
	}

	/** Sends to the tab's chat; a fresh tab's first send creates its chat, with `key`. */
	send(tabId: number, rev: number, seen: number | null, input: Input, key: string | null): Promise<SubmissionId> {
		return this.#submit(tabId, rev, seen, input.requestId, key, async () => input);
	}

	/** Sends the input that the tab's chat offers Retry for again, as a new submission. */
	retry(tabId: number, rev: number, seen: number, entryId: number, requestId: string): Promise<SubmissionId> {
		return this.#submit(tabId, rev, seen, requestId, null, async (chat) => {
			if (chat === null) throw new Error(t("chatMessageGone"));
			// Another panel's Retry may have run since this page showed the button.
			if (await this.#busy(chat)) throw new Error(t("chatBusy"));
			const view = (await this.#attach(chat)).view.value;
			if (projectChat(view).retry !== entryId) throw new Error(t("chatMessageAnswered"));
			const entry = view.entries.find((candidate) => Number(candidate.id) === entryId);
			const message = entry?.model?.[0];
			if (entry === undefined || message?.role !== "user") throw new Error(t("chatMessageGone"));
			const kept: InputEntry | undefined =
				entry.kind === SELECTION_KIND || entry.kind === MESSAGE_KIND || entry.kind === INPUT_KIND
					? { kind: entry.kind, ...(entry.data === undefined ? {} : { data: entry.data }) }
					: undefined;
			return { requestId, content: message.content, ...(kept === undefined ? {} : { entry: kept }) };
		});
	}

	/**
	 * Edit (design 6.34): a new chat with the tab's chat as it was before input `entryId`, then `text` in its place, of
	 * the same kind; the tab shows it. Entries are kept for good, so the chat is forked at the entry before the input,
	 * and the original stays as it is. A first input has nothing before it: the new chat starts empty. Rejected while
	 * the chat runs or has queued inputs. The new chat is submitted to before the tab shows it, so a resend finds both
	 * by the request, and a resend after a lost reply also shows it if the tab has not changed since. `keep`: the
	 * indexes of the input's attachments that go with it (design 6.42).
	 */
	edit(
		tabId: number,
		rev: number,
		seen: number,
		entryId: number,
		text: string,
		keep: readonly number[],
		requestId: string,
	): Promise<SubmissionId> {
		return this.#serial(async () => {
			const created = (await this.#harness.snapshot(ChatsDoc, context))?.chats.find(
				(chat) => chat.request === requestId,
			);
			const admitted =
				created === undefined
					? undefined
					: await this.#harness.commit(
							(tx) => tx.submissionByRequest(created.id as ConversationId, requestId),
							context,
						);
			if (created === undefined || admitted === undefined) {
				const chat = await this.#current(tabId, rev, t("nothingSent"));
				if (chat !== seen) throw new Error(t("chatMessageGone"));
				if (text.trim() === "" && keep.length === 0) throw new Error(t("editEmpty"));
				if (await this.#busy(seen)) throw new Error(t("stopAnswerFirst"));
				const records = await this.#records(seen as ConversationId);
				const at = records.findIndex((record) => Number(record.id) === entryId);
				const entry = records[at];
				if (entry === undefined || !INPUT_KINDS.has(entry.kind) || entry.model?.[0]?.role !== "user")
					throw new Error(t("chatMessageGone"));
				const page = entry.kind === MESSAGE_KIND ? pageOf(entry) : null;
				const moved = page === null ? undefined : await this.#options.moved?.(page);
				const input = editedInput(entry, text, requestId, moved, keep);
				const conversation = await this.#conversation(seen);
				const model = (await conversation.agent(context)).model ?? (await this.#options.defaultModel());
				await this.#options.check(model);
				// The images of the new chat: those its fork starts with, none for a first input (design 6.42).
				const before = records[at - 1]?.id;
				await this.#checkImages(input.content, model, async () =>
					before === undefined ? [] : (await conversation.context(context, { at: before })).messages,
				);
				const target =
					created === undefined
						? await this.#branch(conversation, records[at - 1]?.id, model, requestId)
						: await this.#conversation(created.id);
				const submission = await this.#options.admit(() =>
					target.submit(
						{
							type: "input",
							content: input.content,
							requestId,
							...(input.entry === undefined ? {} : { entry: input.entry }),
						},
						context,
					),
				);
				await this.#show(tabId, rev, seen, Number(target.id));
				return submission.id;
			}
			await this.#show(tabId, rev, seen, created.id);
			return admitted.id;
		});
	}

	/**
	 * Stop: withdraws the queued inputs of the tab's chat and stops its run; a summary that has started finishes. Returns
	 * the text of each input it withdrew, oldest first, and how many attachments it had, which are not kept: those
	 * inputs never ran and leave no transcript entry.
	 */
	abort(tabId: number, rev: number): Promise<{ text: string; lost: number }[]> {
		return this.#serial(async () => {
			const chat = await this.#current(tabId, rev, t("nothingStopped"));
			if (typeof chat !== "number") return [];
			const queued = queuedInputs(await this.#harness.snapshot(InboxDoc, chat as ConversationId, context));
			const conversation = await this.#conversation(chat);
			await this.#options.admit(() => conversation.abort(context));
			// One that a run took before the abort is in the transcript, with Retry.
			const withdrawn: { text: string; lost: number }[] = [];
			for (const input of queued) {
				const record = await (await this.#harness.submission(input.id as SubmissionId, context))?.status(context);
				if (record?.status === "unanswered" && record.entry === undefined)
					withdrawn.push({ text: input.sent ?? input.text, lost: input.attachments?.length ?? 0 });
			}
			return withdrawn;
		});
	}

	/**
	 * Stops every chat with work on `provider`, blocked work and summaries included: its credential was removed, and
	 * that work must not go on with whichever credential is saved next (design 6.20).
	 */
	stopProvider(provider: string): Promise<void> {
		return this.#serial(async () => {
			// From storage, not the task graph's view, which may not show yet what was admitted just before.
			const { tasks, submissions } = await this.#harness.inspect(context);
			const ids = new Set(
				[...tasks.map((task) => task.record.conversationId), ...submissions.map((item) => item.conversationId)].map(
					Number,
				),
			);
			for (const id of ids) {
				const conversation = await this.#harness.conversation(id as ConversationId, context);
				if (conversation === undefined || (await conversation.agent(context)).model?.provider !== provider)
					continue;
				await this.#options.admit(() => conversation.abort(context, { background: true }));
			}
		});
	}

	/** The tab starts fresh. The chat it leaves keeps its run and queued inputs. */
	newChat(tabId: number, rev: number): Promise<void> {
		return this.#serial(async () => {
			const left = await this.#current(tabId, rev, t("tryAgain"));
			if (left === null) return;
			await this.#tabs.set(tabId, (entry) => ({
				...entry,
				chat: null,
				rev: rev + 1,
				resumed: null,
				url: null,
				anchor: null,
				page: null,
			}));
			this.#tabs.invalidateCaptures(tabId);
			if (typeof left === "number") void this.release(left).catch(() => {});
		});
	}

	/** The tab shows chat `target` of the index. The chat it leaves keeps its run and queued inputs. */
	openChat(tabId: number, rev: number, target: number, createdAt?: number): Promise<void> {
		return this.#serial(async () => {
			const left = await this.#current(tabId, rev, t("tryAgain"));
			// Also when the tab shows that ID already: an old row's chat is gone, though a new one has its ID.
			const listed = (await this.#harness.snapshot(ChatsDoc, context))?.chats.some(
				(chat) => isChat(chat, target, createdAt) && !chat.removed,
			);
			if (!listed) throw new Error(t("chatGone"));
			if (left === target) return;
			await this.attach(target);
			await this.#tabs.set(tabId, (entry) => ({ ...entry, chat: target, rev: rev + 1, resumed: null }));
			this.#tabs.invalidateCaptures(tabId);
			if (typeof left === "number") void this.release(left).catch(() => {});
		});
	}

	/** Gives chat `target` the title `title` in History; an empty one brings back its first input's (design 6.30). */
	rename(target: number, title: string, createdAt?: number): Promise<void> {
		return this.#serial(async () => {
			const name = title.replace(/\s+/g, " ").trim().slice(0, MAX_CHAT_TITLE);
			await this.#harness.commit(async (tx) => {
				const chat = (await tx.doc(ChatsDoc)).chats.find((candidate) => isChat(candidate, target, createdAt));
				if (chat === undefined || chat.removed) throw new Error(t("chatGone"));
				if (name === "") delete chat.title;
				else chat.title = name;
			}, context);
		});
	}

	/**
	 * Removes chat `target` from History: it is not listed, opened, or continued by its page again, and the tabs that
	 * show it start a new chat. A chat that runs or has queued inputs must be stopped first (design 6.30).
	 */
	remove(target: number, createdAt?: number): Promise<void> {
		return this.#serial(async () => {
			if (await this.#busy(target)) throw new Error(t("stopAnswerFirst"));
			const index = await this.#harness.snapshot(ChatsDoc, context);
			if (!index?.chats.some((chat) => isChat(chat, target, createdAt))) throw new Error(t("chatGone"));
			// The tabs leave it first: should that fail, it stays listed, never hidden yet still taking their messages.
			await this.#tabs.load();
			const showing = [...this.#tabs.entries()].filter(([, entry]) => entry.chat === target).map(([tabId]) => tabId);
			if (showing.length > 0) {
				// As New chat does, so the tab's next send starts a chat and a panel's older rev is refused.
				await this.#tabs.update((entries) => {
					for (const tabId of showing) {
						const entry = entries.get(tabId);
						if (entry?.chat !== target) continue;
						entries.set(tabId, {
							...entry,
							chat: null,
							rev: entry.rev + 1,
							resumed: null,
							url: null,
							anchor: null,
							page: null,
						});
					}
				});
				for (const tabId of showing) this.#tabs.invalidateCaptures(tabId);
			}
			await this.#harness.commit(async (tx) => {
				const chat = (await tx.doc(ChatsDoc)).chats.find((candidate) => isChat(candidate, target, createdAt));
				if (chat === undefined) throw new Error(t("chatGone"));
				chat.removed = true;
			}, context);
			void this.release(target).catch(() => {});
		});
	}

	/** Undoes `remove`: chat `target` is in History again; no tab shows it until one opens it. */
	restore(target: number, createdAt?: number): Promise<void> {
		return this.#serial(async () => {
			await this.#harness.commit(async (tx) => {
				const chat = (await tx.doc(ChatsDoc)).chats.find((candidate) => isChat(candidate, target, createdAt));
				if (chat === undefined) throw new Error(t("chatGone"));
				delete chat.removed;
			}, context);
		});
	}

	/**
	 * Chat `target` as Markdown, earlier messages included, as History shows its title (design 6.30): questions,
	 * answers, the steps on the way, and the pages they were about. `now` dates the export.
	 */
	async markdown(target: number, now: number, createdAt?: number): Promise<{ title: string; markdown: string }> {
		const index = await this.#harness.snapshot(ChatsDoc, context);
		const chat = index?.chats.find((candidate) => isChat(candidate, target, createdAt) && !candidate.removed);
		if (chat === undefined) throw new Error(t("chatGone"));
		const records = await this.#records(target as ConversationId);
		const view = await (await this.#conversation(target)).viewState(context);
		try {
			const head = view.value.entries[0]?.head;
			const earlier = head === undefined ? undefined : projectEarlier(records, Number(head));
			const entries = projectChat(view.value, earlier).entries;
			const title = chat.title ?? records.map(inputTitle).find((found) => found !== undefined) ?? t("newChat");
			return { title, markdown: chatMarkdown(title, chat.createdAt, now, entries) };
		} finally {
			view.dispose();
		}
	}

	/**
	 * Image `index` of entry `entryId` of the tab's chat, in the order of its content, as the model got it; null without
	 * one (design 6.26, 6.42).
	 */
	async image(tabId: number, entryId: number, index: number): Promise<StoredImage | null> {
		if (!Number.isInteger(index) || index < 0) return null;
		await this.#tabs.load();
		const chat = this.#tabs.get(tabId)?.chat;
		if (typeof chat !== "number") return null;
		// The chat's entries: an edited chat's first ones are its original's (design 6.34).
		const id = entryId as EntryId;
		const entry = await this.#harness.commit(
			async (tx) =>
				(await tx.scanEntries({ conversationId: chat as ConversationId, minEntryId: id, maxEntryId: id }, 1))
					.items[0],
			context,
		);
		if (entry === undefined) return null;
		const message = entry.model?.[0];
		if (message === undefined || message.role === "assistant" || typeof message.content === "string") return null;
		const block = message.content.flatMap((each) => (each.type === "image" ? [each] : []))[index];
		return block === undefined ? null : { mimeType: block.mimeType, data: block.data };
	}

	/**
	 * Running chats first, also those beyond the newest 50, then the others, newest first; each titled by its first
	 * input. A chat without an input is left out, unless the tab shows it or it runs.
	 */
	async list(tabId: number | null): Promise<ChatSummary[]> {
		await this.#tabs.load();
		const index = await this.#harness.snapshot(ChatsDoc, context);
		const current = tabId === null ? undefined : this.#tabs.get(tabId)?.chat;
		const newest = [...(index?.chats ?? [])].reverse().filter((chat) => !chat.removed);
		const running = this.#running;
		const summaries: ChatSummary[] = [];
		let others = 0;
		for (const chat of [
			...newest.filter((chat) => running.has(chat.id)),
			...newest.filter((chat) => !running.has(chat.id)),
		]) {
			const runs = running.has(chat.id);
			if (!runs && others === MAX_LISTED) break;
			// The title of the first input, and the first page an input was about: usually the same input.
			const { title, page } = await this.#harness.commit(async (tx) => {
				const first = await tx.scanEntries({ conversationId: chat.id as ConversationId, order: "ascending" }, 20);
				let title: string | undefined;
				let page: PageRef | null = null;
				for (const entry of first.items) {
					title ??= inputTitle(entry);
					page ??= pageOf(entry);
					if (title !== undefined && page !== null) break;
				}
				return { title, page };
			}, context);
			const active = chat.id === current;
			if (title === undefined && !active && !runs) continue;
			if (!runs) others += 1;
			summaries.push({
				id: chat.id,
				createdAt: chat.createdAt,
				title: chat.title ?? (title || t("newChat")),
				page: page === null ? null : { url: page.url, title: page.title },
				active,
				running: runs,
				edited: chat.from !== undefined,
			});
		}
		return summaries;
	}

	/**
	 * Changes the model of the tab's chat, if it has one, and of new chats. Rejected while the chat is busy: the change
	 * would reach the running answer.
	 */
	setModel(tabId: number, rev: number, model: ModelRef): Promise<void> {
		return this.#serial(async () => {
			const chat = await this.#current(tabId, rev, t("modelUnchanged"));
			if (typeof chat === "number") {
				const conversation = await this.#conversation(chat);
				const current = (await conversation.agent(context)).model;
				if (current?.provider !== model.provider || current.modelId !== model.modelId) {
					if (await this.#busy(chat)) {
						throw new Error(t("chatBusyModel"));
					}
					await conversation.configure({ model }, context);
				}
			}
			await this.#options.setDefaultModel(model);
		});
	}

	/**
	 * Retires the page snapshots of chat `id` when no open tab shows it and it has no run and no queued input: its next
	 * run reads the pages again. A command, so a tab that takes the chat meanwhile is seen.
	 */
	release(id: number): Promise<void> {
		return this.#serial(async () => {
			await this.#tabs.load();
			const holders = [...this.#tabs.entries()].filter(([, entry]) => entry.chat === id).map(([tabId]) => tabId);
			if (holders.length > 0) {
				const open = await this.#options.openTabs();
				if (holders.some((tabId) => open.has(tabId))) return;
			}
			if (await this.#busy(id)) return;
			await this.#harness.commit(async (tx) => {
				const state = await tx.doc(PageReadsDoc, id as ConversationId);
				if (state.tabs.length === 0) {
					await tx.retireDoc(PageReadsDoc, id as ConversationId);
					return;
				}
				// Ownership belongs to the chat; only its temporary page data is disposable.
				state.run = 0;
				state.calls = [];
				state.snapshots = [];
				state.tab = null;
			}, context);
		});
	}

	dispose(): void {
		for (const watched of this.#views.values()) watched.view.dispose();
		this.#views.clear();
		this.#graph?.dispose();
		this.#graph = undefined;
	}

	/**
	 * A resend after a lost reply finds the first admission: in the chat the page saw, the tab's chat, or the chat the
	 * request created as a fresh tab's first send; also when the tab shows another chat now. Otherwise the tab must
	 * still have `rev`, and `build(chat)` makes the input for the tab's chat. A fresh tab's chat is created, or found by
	 * the request that created it, and recorded before anything is submitted.
	 */
	#submit(
		tabId: number,
		rev: number,
		seen: number | null,
		requestId: string,
		key: string | null,
		build: (chat: number | null) => Promise<Input>,
	): Promise<SubmissionId> {
		return this.#serial(async () => {
			await this.#tabs.load();
			const tab = this.#tabs.get(tabId);
			const bound = tab?.chat ?? null;
			// Also when the tab holds another chat now: New chat and a send, or History, since the first send.
			const created = (await this.#harness.snapshot(ChatsDoc, context))?.chats.find(
				(chat) => chat.request === requestId,
			)?.id;
			for (const id of new Set([seen, bound, created])) {
				if (id == null) continue;
				const admitted = await this.#harness.commit(
					(tx) => tx.submissionByRequest(id as ConversationId, requestId),
					context,
				);
				if (admitted !== undefined) return admitted.id;
			}
			await this.#current(tabId, rev, t("nothingSent"));
			const { content, entry, whenBusy } = await build(bound);
			const existing = bound ?? created;
			const conversation = existing === undefined ? undefined : await this.#conversation(existing);
			const model =
				(conversation === undefined ? undefined : (await conversation.agent(context)).model) ??
				(await this.#options.defaultModel());
			await this.#options.check(model);
			await this.#checkImages(
				content,
				model,
				async () => (conversation === undefined ? [] : (await conversation.context(context)).messages),
				conversation === undefined ? undefined : Number(conversation.id),
			);
			const thinking = await this.#options.thinking(model);
			// Only while idle: switching thinking within a run, between a tool call and its answer, can make the provider
			// reject the request. A running answer and the inputs queued behind it keep the level they started with.
			if (
				conversation !== undefined &&
				(await conversation.agent(context)).thinkingLevel !== thinking &&
				!(await this.#busy(Number(conversation.id)))
			) {
				await conversation.configure({ thinkingLevel: thinking }, context);
			}
			const target = conversation ?? (await this.#create(model, thinking, requestId, key));
			if (bound === null) {
				const chat = Number(target.id);
				await this.attach(chat);
				// If this fails, nothing is submitted; the resend finds the chat by its request.
				await this.#tabs.set(tabId, (current) => ({ ...current, chat }));
			}
			const submission = await this.#options.admit(() =>
				target.submit(
					{
						type: "input",
						content,
						requestId,
						whenBusy: whenBusy ?? "followUp",
						...(entry === undefined ? {} : { entry }),
					},
					context,
				),
			);
			// The note about a continued chat shows until the tab's next send.
			if (tab?.resumed != null) {
				await this.#tabs.set(tabId, (current) => ({ ...current, resumed: null })).catch(() => {});
			}
			return submission.id;
		});
	}

	/**
	 * The tab's chat (undefined while unresolved), after checking that the tab is open and still has `rev`. A tab
	 * without an entry has `rev` 0. A closed or replaced tab's ID rejects every command, also when the save that
	 * dropped or moved its entry failed and the entry is still there.
	 */
	async #current(tabId: number, rev: number, what: string): Promise<number | null | undefined> {
		await this.#tabs.load();
		if (!(await this.#options.tabOpen(tabId))) throw new Error(t("tabClosed", [what]));
		const tab = this.#tabs.get(tabId);
		if ((tab?.rev ?? 0) !== rev) throw new TabChanged(what);
		return tab?.chat;
	}

	async #conversation(id: number): Promise<Conversation> {
		const conversation = await this.#harness.conversation(id as ConversationId, context);
		if (conversation === undefined) throw new Error(t("chatGone"));
		return conversation;
	}

	/**
	 * The tab shows chat `target` if it still has `rev` and shows `seen`, with a new `rev` as after opening a chat;
	 * `seen` keeps its run and queued inputs.
	 */
	async #show(tabId: number, rev: number, seen: number, target: number): Promise<void> {
		await this.#tabs.load();
		const tab = this.#tabs.get(tabId);
		if (tab?.rev !== rev || tab.chat !== seen) return;
		await this.attach(target);
		await this.#tabs.set(tabId, (entry) => ({ ...entry, chat: target, rev: rev + 1, resumed: null }));
		this.#tabs.invalidateCaptures(tabId);
		void this.release(seen).catch(() => {});
	}

	/**
	 * Edit's new chat: a fork of `parent` at entry `at`, or without one an empty chat. Indexed with the parent's page
	 * key, so the page continues the newer chat (rule 2), and the request, so a resend finds it.
	 */
	async #branch(
		parent: Conversation,
		at: EntryId | undefined,
		model: ModelRef,
		request: string,
	): Promise<Conversation> {
		const createdAt = (this.#options.now ?? Date.now)();
		const from = Number(parent.id);
		const key =
			(await this.#harness.snapshot(ChatsDoc, context))?.chats.find((chat) => chat.id === from)?.key ?? null;
		const options = {
			ownership: { kind: "ownerless" } as const,
			agent: { model, thinkingLevel: await this.#options.thinking(model) },
			init: async (tx: Tx, id: ConversationId) => {
				(await tx.doc(ChatsDoc)).chats.push({ id: Number(id), createdAt, request, key, from });
			},
		};
		return at === undefined ? this.#harness.createConversation(options, context) : parent.fork(at, options, context);
	}

	/** Every entry of a chat in append order, an edited chat's from its original included. */
	#records(conversationId: ConversationId): Promise<EntryRecord[]> {
		return this.#harness.commit(async (tx) => {
			const found: EntryRecord[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanEntries({ conversationId, order: "ascending" }, 200, cursor);
				found.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			return found;
		}, context);
	}

	/** Creates a chat with an explicit model and thinking level; the same commit adds it to the index. */
	async #create(
		model: ModelRef,
		thinking: ModelThinkingLevel,
		request: string,
		key: string | null,
	): Promise<Conversation> {
		const createdAt = (this.#options.now ?? Date.now)();
		return this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model, thinkingLevel: thinking },
				init: async (tx, id) => {
					(await tx.doc(ChatsDoc)).chats.push({ id: Number(id), createdAt, request, key });
				},
			},
			context,
		);
	}

	#runningIn(graph: TaskGraph): Set<number> {
		const running = new Set<number>();
		for (const task of Object.values(graph.tasks)) {
			if (task.blocked === undefined) running.add(Number(task.conversationId));
		}
		return running;
	}

	/** Projects a watched chat; loads the entries before its active context when that context starts elsewhere. */
	#project(watched: Watched, value: ConversationView): void {
		const head = value.entries[0]?.head;
		if ((head === undefined ? undefined : Number(head)) !== watched.earlier.head) {
			watched.earlier = { head: head === undefined ? undefined : Number(head), entries: [], cacheHit: undefined };
			if (head !== undefined) void this.#loadEarlier(watched, value.conversation.id, head).catch(() => {});
		}
		const first = (value.docs["pi.live"] as LiveState | undefined)?.run?.inputs[0];
		if (first === undefined) watched.run = undefined;
		else if (watched.run?.first !== String(first))
			watched.run = { first: String(first), startedAt: (this.#options.now ?? Date.now)() };
		watched.chat = { ...projectChat(value, watched.earlier, watched.run?.startedAt), editedFrom: watched.from };
	}

	async #loadEarlier(watched: Watched, id: ConversationId, head: EntryId): Promise<void> {
		// All of them: an older compaction's marker can follow the head and still start a group before it.
		const records = await this.#records(id);
		if (watched.earlier.head !== Number(head)) return;
		watched.earlier = { head: Number(head), ...projectEarlier(records, Number(head)) };
		watched.chat = {
			...projectChat(watched.view.value, watched.earlier, watched.run?.startedAt),
			editedFrom: watched.from,
		};
		this.#options.changed();
	}

	/**
	 * Before an input with images is admitted (design 6.42): the model it runs on reads images, and the chat's requests
	 * stay within pi's soft caps with them, counting the images of chat `chat`'s queued inputs, read first, then those of
	 * `messages`, its context, then the new ones. An input without images is not checked: on a model that cannot read
	 * images, the chat's older ones go as pi-ai's placeholder.
	 */
	async #checkImages(
		content: UserMessage["content"],
		model: ModelRef,
		messages: () => Promise<readonly Message[]>,
		chat?: number,
	): Promise<void> {
		const added = imagesIn([{ role: "user", content, timestamp: 0 }]);
		if (added.count === 0) return;
		const limit = await this.#options.imageLimit(model);
		if (limit === null) throw new Error(t("modelNoImages"));
		const inbox =
			chat === undefined ? undefined : await this.#harness.snapshot(InboxDoc, chat as ConversationId, context);
		const sent = chatImages(inbox, await messages());
		const total = { count: sent.count + added.count, bytes: sent.bytes + added.bytes };
		if (total.count > limit) throw new Error(t("imagesOverCount", [sent.count, total.count, limit]));
		const mb = (chars: number) => (chars / 1e6).toFixed(1);
		if (total.bytes > MAX_IMAGE_BYTES)
			throw new Error(t("imagesOverSize", [mb(sent.bytes), mb(total.bytes), MAX_IMAGE_BYTES / 1e6]));
	}

	/** The chat runs or has queued inputs, as committed. */
	async #busy(id: number): Promise<boolean> {
		const conversationId = id as ConversationId;
		if ((await this.#harness.snapshot(LiveDoc, conversationId, context))?.run !== undefined) return true;
		return ((await this.#harness.snapshot(InboxDoc, conversationId, context))?.items.length ?? 0) > 0;
	}
}

/**
 * A message about `page`: the model gets the text, then the page's title and URL, and where the tab is if it `moved`
 * (design 6.28), then the attachments (6.42); the entry keeps the text, the page, the move, and what is attached.
 */
export function pageInput(
	requestId: string,
	text: string,
	page: PageRef,
	prompt: string | undefined,
	moved?: PageMove,
	attachments: Attachments = NO_ATTACHMENTS,
): Input {
	const data: MessageData = {
		text,
		page,
		...(prompt === undefined ? {} : { prompt }),
		...(moved === undefined ? {} : { moved }),
		...(attachments.infos.length === 0 ? {} : { attachments: attachments.infos }),
	};
	// The titles are the pages': quoted as JSON strings, so they cannot end the line or the quotes.
	const note = `[Attached page: ${JSON.stringify(pageTitle(page.title))} (${page.url.slice(0, MAX_URL_CHARS)})${movedNote(moved)}]`;
	return {
		requestId,
		content: withAttachments(text === "" ? note : `${text}\n\n${note}`, attachments.blocks),
		entry: { kind: MESSAGE_KIND, data },
	};
}

/** What an input's entry stores of its attachments, and their content blocks, in the same order (design 6.42). */
export type Attachments = { infos: AttachmentInfo[]; blocks: AttachmentBlock[] };

const NO_ATTACHMENTS: Attachments = { infos: [], blocks: [] };

/**
 * A typed message with neither a page nor a selection: the text as before, or with attachments, a `web.input` entry
 * that names them (design 6.42).
 */
export function typedInput(requestId: string, text: string, attachments: Attachments = NO_ATTACHMENTS): Input {
	if (attachments.infos.length === 0) return { requestId, content: text };
	return {
		requestId,
		content: withAttachments(text, attachments.blocks),
		entry: { kind: INPUT_KIND, data: { text, attachments: attachments.infos } },
	};
}

/** What the model is told of a tab that left its attached page. */
function movedNote(moved: PageMove | undefined): string {
	if (moved === undefined) return "";
	if ("url" in moved)
		return `; the tab now shows ${JSON.stringify(pageTitle(moved.title))} (${moved.url.slice(0, MAX_URL_CHARS)})`;
	// Where pi last saw the tab sent, not where it is: Back or the address bar move it unseen (design 6.28).
	return `; the tab has since moved to a page pi cannot read${moved.site === null ? "" : `; it was last seen going to ${moved.site}`}`;
}

/**
 * Input `entry` with `text` in place of what the user wrote (design 6.34), of the same kind. A typed message keeps its
 * page, with where the tab is now if it `moved` (6.28); a page prompt's name stays only while its text is unchanged. A
 * selection keeps its quote, which shows as the preset only while the prompt is unchanged (6.13). `keep`: the indexes
 * of its attachments that go with it, in their stored order (6.42); a wrong one rejects the edit.
 */
export function editedInput(
	entry: EntryRecord,
	text: string,
	requestId: string,
	moved?: PageMove,
	keep: readonly number[] = [],
): Input {
	const data = inputData(entry.kind, entry.data);
	const message = entry.model?.[0];
	const stored = storedAttachments(entry.data, message?.role === "user" ? message.content : undefined);
	const count = stored?.attachments.length ?? 0;
	if (
		new Set(keep).size !== keep.length ||
		keep.some((index) => !Number.isInteger(index) || index < 0 || index >= count)
	)
		throw new Error(t("attachmentGone"));
	const kept: Attachments = {
		infos: stored?.attachments.filter((_, index) => keep.includes(index)) ?? [],
		blocks: stored?.blocks.filter((_, index) => keep.includes(index)) ?? [],
	};
	if (data !== undefined && entry.kind === MESSAGE_KIND) {
		const { prompt } = data as Partial<MessageData>;
		return pageInput(requestId, text, data.page, draftEdited(text, data.text) ? undefined : prompt, moved, kept);
	}
	if (data !== undefined && entry.kind === SELECTION_KIND && message?.role === "user") {
		const { edited, attachments: _attachments, ...selection } = data as SelectionEntryData;
		const changed = edited !== false || draftEdited(text, stored?.lead ?? contentText(message.content));
		return {
			requestId,
			content: withAttachments(text, kept.blocks),
			entry: {
				kind: SELECTION_KIND,
				data: {
					...selection,
					edited: changed,
					...(kept.infos.length === 0 ? {} : { attachments: kept.infos }),
				} satisfies SelectionEntryData,
			},
		};
	}
	return typedInput(requestId, text, kept);
}

/**
 * A chat as Markdown: its title, when it started and was exported, then each question under "You", each answer under
 * "pi", and the steps between as a list. An entry's page is a link under it; an error is a quote.
 */
export function chatMarkdown(title: string, createdAt: number, now: number, entries: readonly ChatEntry[]): string {
	const when = (time: number) => new Date(time).toISOString().replace("T", " ").slice(0, 16);
	const lines = [`# ${title}`, "", `Started ${when(createdAt)} UTC · exported from pi ${when(now)} UTC`];
	let steps = false;
	const link = (page: { title: string; url: string }) =>
		`[${(page.title || page.url).replace(/[[\]]/g, "")}](<${page.url}>)`;
	// One blank line between parts. A message keeps the blank lines inside it, which can be code or a string's data;
	// only those at its ends go.
	const blank = () => {
		if (lines.at(-1) !== "") lines.push("");
	};
	const message = (text: string) => {
		const trimmed = text.replace(/^\n+|\n+$/g, "");
		if (trimmed !== "") lines.push(trimmed);
	};
	for (const entry of entries) {
		const step = entry.step || entry.role === "notice";
		if (step && !steps) blank();
		if (!step && steps) steps = false;
		if (entry.role === "user") {
			blank();
			lines.push("## You", "");
			if (entry.quote !== null)
				lines.push(`**${entry.quote.preset}**`, "", ...entry.quote.text.split("\n").map((line) => `> ${line}`));
			else message(entry.text);
			if (entry.attachments !== undefined) {
				blank();
				lines.push("Attached (not included in this export):");
				for (const each of entry.attachments)
					lines.push(each.kind === "file" ? `- File: ${each.name}` : `- Image, ${each.width} × ${each.height}`);
			}
			if (entry.source !== null) {
				blank();
				lines.push(`Page: ${link(entry.source)}`);
			}
		} else if (step) {
			steps = true;
			const text = entry.role === "notice" ? entry.text : entry.text.replace(/\s+/g, " ").trim();
			if (text !== "") lines.push(`- ${text}${entry.detail === null ? "" : ` (${entry.detail})`}`);
			if (entry.error !== null) lines.push(`  - Error: ${entry.error}`);
		} else {
			blank();
			lines.push("## pi", "");
			message(entry.text);
			if (entry.stopped || entry.error !== null) {
				blank();
				lines.push(entry.stopped ? `> ${t("answerStopped")}` : `> Error: ${entry.error}`);
			}
		}
	}
	while (lines.at(-1) === "") lines.pop();
	return `${lines.join("\n")}\n`;
}
