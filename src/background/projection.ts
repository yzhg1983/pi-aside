import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Usage as TokenUsage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	type AgentState,
	type ConversationView,
	DEFAULT_COMPACTION_POLICY,
	type EntryRecord,
	type InboxState,
	type LiveState,
	type UsageState,
} from "@earendil-works/pi-durable";
import { storedAttachments } from "../shared/attachments.ts";
import { t } from "../shared/i18n.ts";
import {
	type AnswerStats,
	type AttachmentInfo,
	type ChatEntry,
	type ChatView,
	cut,
	type InputData,
	isProvider,
	type MessageData,
	type PageMove,
	type PageRef,
	type QueuedInput,
	type SelectionData,
	type SelectionEntryData,
	type Usage,
} from "../shared/protocol.ts";
import { type Step, stepText } from "./page-agent.ts";

/** A page tool's summary from the model, on one line; null when empty. */
export const summaryOf = (summary: string | undefined): string | null => {
	const line = summary?.replace(/\s+/g, " ").trim() ?? "";
	return line === "" ? null : line;
};

/** A script's code as the chat shows it under its line: on one line, cut at 300 characters. */
export const codePreview = (code: string): string => cut(code.replace(/\s+/g, " ").trim(), 300);

/** Entry kind of an input made from a page selection; `data` is `SelectionData`. */
export const SELECTION_KIND = "web.selection";
/** Entry kind of a typed input with a page attached; `data` is `MessageData`. */
export const MESSAGE_KIND = "web.message";
/** Entry kind of a typed input with attachments and neither a page nor a selection; `data` is `InputData` (6.42). */
export const INPUT_KIND = "web.input";

export const EMPTY_CHAT: ChatView = {
	conversationId: null,
	model: null,
	entries: [],
	live: null,
	busy: false,
	queued: [],
	retry: null,
	usage: null,
	progress: null,
	context: { tokens: 0, auto: DEFAULT_COMPACTION_POLICY.enabled },
	editedFrom: null,
};

/** Entry kinds of inputs: what the user sent. */
export const INPUT_KINDS = new Set(["pi.user", SELECTION_KIND, MESSAGE_KIND, INPUT_KIND]);
/** Stop reasons of an answer the model finished; anything else ("error", "aborted") offers Retry. */
const COMPLETE = new Set(["stop", "length", "toolUse"]);

/**
 * The projected entries before a chat's active context, which starts at the newest compaction or reset, and the cache
 * hit rate of their last model call, hidden calls included; undefined without one.
 */
export type Earlier = { entries: ChatEntry[]; cacheHit: number | null | undefined };

/**
 * What a panel shows of one conversation: its transcript, the answer in progress, and the queue. `runStartedAt`: when
 * the running run started, for its progress.
 */
export function projectChat(
	view: ConversationView,
	earlier: Earlier = { entries: [], cacheHit: undefined },
	runStartedAt = Date.now(),
): ChatView {
	const entries: ChatEntry[] = [...earlier.entries];
	let lastInput: number | undefined;
	let answered = false;
	const live = view.docs["pi.live"] as LiveState | undefined;
	const busy = live?.run !== undefined;
	for (const [entry, projected] of projectRecords(view.entries, groupStarts(view.entries), !busy)) {
		entries.push(projected);
		if (INPUT_KINDS.has(entry.kind)) {
			lastInput = projected.id;
			answered = false;
		} else if (entry.kind === "pi.assistant") {
			answered = COMPLETE.has((entry.model?.[0] as AssistantMessage | undefined)?.stopReason ?? "");
		}
	}
	const inbox = view.docs["pi.inbox"] as InboxState | undefined;
	const agent = view.docs["pi.agent"] as AgentState | undefined;
	const spent = view.docs["pi.usage"] as UsageState | undefined;
	const message = live?.generation?.message as AssistantMessage | undefined;
	// After a compaction with no model call since, the last call before it.
	const lastCall = view.entries.map(modelUsage).findLast((usage) => usage !== undefined);
	const cacheHit = lastCall === undefined ? (earlier.cacheHit ?? null) : hitRate(lastCall);
	return {
		conversationId: Number(view.conversation.id),
		model:
			agent?.model !== undefined && isProvider(agent.model.provider)
				? { provider: agent.model.provider, modelId: agent.model.modelId }
				: null,
		entries: mergeReads(entries),
		live:
			live?.generation === undefined
				? null
				: {
						text: message === undefined ? "" : messageText(message),
						thinking: message === undefined ? "" : thinkingText(message),
						attempt: live.generation.attempt,
						retry: live.generation.retry?.error ?? null,
					},
		busy,
		queued: queuedInputs(inbox),
		retry: !busy && lastInput !== undefined && !answered ? lastInput : null,
		progress: busy ? runProgress(view.entries, live.run?.inputs.length || 1, runStartedAt) : null,
		context: contextUsage(view.entries),
		editedFrom: null,
		usage:
			spent === undefined
				? null
				: totalUsage([...Object.values(spent.models), ...Object.values(spent.tools)], cacheHit),
	};
}

/**
 * The running run, which has `inputs` inputs: it starts at its first one, the `inputs`-th input entry from the end. A
 * steer joins the run as one more input (design 6.39), so the tools before it still count. Without the first input in
 * view (a compaction since), from the start of the view.
 */
function runProgress(
	entries: readonly EntryRecord[],
	inputs: number,
	startedAt: number,
): NonNullable<ChatView["progress"]> {
	let start = -1;
	for (let at = entries.length - 1, seen = 0; at >= 0; at--) {
		if (INPUT_KINDS.has(entries[at]!.kind) && ++seen === inputs) {
			start = at;
			break;
		}
	}
	const run = entries.slice(start + 1);
	return {
		startedAt,
		tools: run.filter((entry) => entry.model?.[0]?.role === "toolResult").length,
		from: Number(entries[Math.max(start, 0)]?.id ?? 0),
	};
}

/** Latest measured request plus estimated trailing messages; a head marker invalidates earlier usage. */
function contextUsage(entries: readonly EntryRecord[]): ChatView["context"] {
	const head = entries[0]?.head === undefined ? -Infinity : Number(entries[0].id);
	let tokens = 0;
	let measured = false;
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const usage = message.role === "assistant" ? message.usage : undefined;
			if (
				message.role === "assistant" &&
				Number(entry.id) > head &&
				usage !== undefined &&
				message.stopReason !== "error" &&
				message.stopReason !== "aborted" &&
				calculateContextTokens(usage) > 0
			) {
				tokens = calculateContextTokens(usage);
				measured = true;
			} else tokens += estimateMessageTokens(message);
		}
	}
	return { tokens: head !== -Infinity && !measured ? null : tokens, auto: DEFAULT_COMPACTION_POLICY.enabled };
}

/**
 * Successive successful reads of the same page as one notice, "Read the page: X · 3 reads": a long page is read in
 * parts. The merged notice takes the ID of the last read. A group grows only while it is the last entry, so its ID
 * changes with its text, and a panel replaces it like any changed entry.
 */
function mergeReads(entries: readonly ChatEntry[]): ChatEntry[] {
	const merged: ChatEntry[] = [];
	let group: { text: string; kind: ChatEntry["read"]; count: number } | undefined;
	for (const entry of entries) {
		const read = entry.role === "notice" && entry.error === null && entry.read !== undefined;
		if (read && group !== undefined && group.kind === entry.read && group.text === entry.text) {
			group.count += 1;
			merged[merged.length - 1] = { ...entry, text: t("readCount", [entry.text, group.count]) };
			continue;
		}
		group = read ? { text: entry.text, kind: entry.read, count: 1 } : undefined;
		merged.push(entry);
	}
	return merged;
}

/** Projected entries in order, without those a panel does not show. */
export function projectEntries(records: readonly EntryRecord[]): ChatEntry[] {
	return projectRecords(records).map(([, entry]) => entry);
}

/**
 * The entries before a chat's active context, which starts at `head`, from all its records in append order. A
 * compaction's marker follows the entries it kept, so a marker after `head` can still start a group before it.
 */
export function projectEarlier(records: readonly EntryRecord[], head: number): Earlier {
	const before = records.filter((record) => Number(record.id) < head);
	const lastCall = before.map(modelUsage).findLast((usage) => usage !== undefined);
	return {
		entries: projectRecords(before, groupStarts(records)).map(([, entry]) => entry),
		cacheHit: lastCall === undefined ? undefined : hitRate(lastCall),
	};
}

/**
 * The first entry each compaction or reset kept starts a group: calls before it were summarized and are in the chat's
 * line only. The marker comes first in the active context but after the entries it kept in append order.
 */
function groupStarts(records: readonly EntryRecord[]): Set<number> {
	return new Set(records.flatMap((record) => (record.head === undefined ? [] : [Number(record.head)])));
}

/**
 * The records a panel shows, each with its projection. A turn runs from an input to the next, or to a group's start:
 * its last shown answer gets the usage and stats of all its model calls and tool results, the steps before it none
 * (design 6.21). A steer joins the turn it was sent into (design 6.39). `closed`: the last turn ended, so its last
 * answer is known.
 */
function projectRecords(
	records: readonly EntryRecord[],
	starts = groupStarts(records),
	closed = true,
): [EntryRecord, ChatEntry][] {
	const shown: [EntryRecord, ChatEntry][] = [];
	let turn = new Turn();
	// The index in `shown` of the turn's last answer.
	let last: number | undefined;
	const close = () => {
		const answer = last === undefined ? undefined : shown[last];
		if (answer !== undefined) answer[1] = { ...answer[1], usage: totalUsage(turn.calls), stats: turn.stats() };
		turn = new Turn();
		last = undefined;
	};
	// The arguments of each tool call, by its ID: a result pi-durable made (Stop, an interruption) has no details.
	const sources = new Map<string, Record<string, unknown>>();
	// The last record the model sees, before this one, and whether the last input joined a running run.
	let previous: EntryRecord | undefined;
	let joined = false;
	for (const record of records) {
		if (INPUT_KINDS.has(record.kind)) joined = steered(record, previous, joined);
		if (starts.has(Number(record.id)) || (INPUT_KINDS.has(record.kind) && !joined)) close();
		if (record.model !== undefined) previous = record;
		const message = record.model?.[0];
		if (record.kind === "pi.assistant" && message?.role === "assistant") turn.call(message);
		else if (message?.role === "toolResult") turn.result(message);
		if (message?.role === "assistant")
			for (const block of message.content) if (block.type === "toolCall") sources.set(block.id, block.arguments);
		const projected = projectEntry(record, sources);
		if (projected === undefined) continue;
		if (projected.role === "assistant") last = shown.length;
		shown.push([record, projected]);
	}
	if (closed) close();
	return shown;
}

/**
 * Whether an input joined a running run: a steer is placed by the run's own task after a tool round, so it follows a
 * tool result, or the steers that task placed with it in a burst (design 6.39). `joined`: whether the input before it
 * did. An input that starts a run is placed by its send, with no task, also after a run stopped in its tools, or after
 * steers placed before a Stop; one placed when a run ends follows its answer.
 */
function steered(input: EntryRecord, previous: EntryRecord | undefined, joined: boolean): boolean {
	if (input.byTaskId === undefined || previous === undefined) return false;
	if (INPUT_KINDS.has(previous.kind)) return joined && previous.byTaskId === input.byTaskId;
	return previous.model?.[0]?.role === "toolResult";
}

/** What one turn's model calls and tool results add up to. */
class Turn {
	readonly calls: TokenUsage[] = [];
	/** The measured calls' time; null before one. */
	#modelMs: number | null = null;
	/** A call stored before pi-ai measured calls: the turn's time is not known. */
	#unmeasured = false;
	/** Each tool's run as [start, end], for the time they ran, overlaps once. */
	readonly #runs: [number, number][] = [];
	readonly #tools = new Map<string, { calls: number; failed: number }>();

	call(message: AssistantMessage): void {
		if (message.usage !== undefined) this.calls.push(message.usage);
		if (message.durationMs !== undefined) this.#modelMs = (this.#modelMs ?? 0) + message.durationMs;
		// An attempt cut short, by Stop or a worker restart, is stored from its last partial, without its time: the
		// turn's time leaves it out rather than going unknown, so an answer recovered after a restart keeps its line.
		else if (message.stopReason !== "aborted") this.#unmeasured = true;
	}

	result(message: ToolResultMessage): void {
		const tool = this.#tools.get(message.toolName) ?? { calls: 0, failed: 0 };
		tool.calls += 1;
		if (message.isError) tool.failed += 1;
		this.#tools.set(message.toolName, tool);
		// A call refused before it ran, or a result pi-durable made, has no duration: it took no tool time.
		if (message.durationMs !== undefined)
			this.#runs.push([message.timestamp - message.durationMs, message.timestamp]);
	}

	/** Null when there is nothing to show: no recorded model time and no tool. */
	stats(): AnswerStats | null {
		const modelMs = this.#unmeasured ? null : this.#modelMs;
		if (modelMs === null && this.#tools.size === 0) return null;
		let toolMs = 0;
		let end = -Infinity;
		for (const [start, stop] of this.#runs.toSorted((a, b) => a[0] - b[0])) {
			toolMs += Math.max(0, stop - Math.max(start, end));
			end = Math.max(end, stop);
		}
		return {
			modelMs,
			toolMs,
			tools: [...this.#tools].map(([name, { calls, failed }]) => ({ name, calls, failed })),
		};
	}
}

/** The usage of an answer's model call. */
function modelUsage(record: EntryRecord): TokenUsage | undefined {
	return record.kind === "pi.assistant" ? (record.model?.[0] as AssistantMessage | undefined)?.usage : undefined;
}

/** The share of a call's prompt read from the cache. pi-ai's `input` excludes the cache reads and writes. */
function hitRate({
	input,
	cacheRead,
	cacheWrite,
}: Pick<TokenUsage, "input" | "cacheRead" | "cacheWrite">): number | null {
	const prompt = input + cacheRead + cacheWrite;
	return prompt > 0 ? cacheRead / prompt : null;
}

/**
 * A title for the history list: the first line of an input as the panel shows it, bounded. A page prompt adds the
 * page's title, so "Summarize" on two pages gives two titles.
 */
export function inputTitle(entry: EntryRecord): string | undefined {
	if (!INPUT_KINDS.has(entry.kind)) return undefined;
	const data = inputData(entry.kind, entry.data);
	const prompt = data === undefined ? undefined : promptOf(entry.kind, data);
	// A selection stored before the `edited` flag still gets its preset title.
	const text =
		data !== undefined && prompt !== undefined
			? `${prompt}: ${data.page.title || data.page.url}`
			: entry.kind === SELECTION_KIND && data !== undefined && (data as Partial<SelectionEntryData>).edited !== true
				? `${(data as SelectionData).preset}: ${data.text}`
				: projectEntry(entry, new Map())?.text;
	let line = (text ?? "").replace(/\s+/g, " ").trim().toWellFormed();
	// A message of attachments only: its first one's name.
	if (line === "") {
		const first = projectEntry(entry, new Map())?.attachments?.[0];
		if (first !== undefined) line = first.kind === "file" ? first.name : t("attachedImage");
	}
	return line.length > 80 ? `${cut(line, 79)}…` : line;
}

/** The sum of `parts`, with the cache hit rate over all of them unless `cacheHit` is given. */
function totalUsage(parts: readonly TokenUsage[], cacheHit?: number | null): Usage | null {
	if (parts.length === 0) return null;
	const sum = (count: (part: TokenUsage) => number) => parts.reduce((total, part) => total + count(part), 0);
	const input = sum((part) => part.input);
	const cacheRead = sum((part) => part.cacheRead);
	const cacheWrite = sum((part) => part.cacheWrite);
	return {
		input,
		output: sum((part) => part.output),
		cacheRead,
		cacheWrite,
		cost: sum((part) => part.cost.total),
		planCost: sum(planEstimate),
		cacheHit: cacheHit !== undefined ? cacheHit : hitRate({ input, cacheRead, cacheWrite }),
	};
}

/**
 * The list-price estimate of calls on a ChatGPT plan: their cost's parts are at list prices, their total 0 (design
 * 6.20). Other calls' parts add up to their total, but for a rounding error in a sum of calls.
 */
function planEstimate({ cost }: TokenUsage): number {
	const extra = cost.input + cost.output + cost.cacheRead + cost.cacheWrite - cost.total;
	return extra > 1e-9 ? extra : 0;
}

function projectEntry(
	entry: EntryRecord,
	sources: ReadonlyMap<string, Record<string, unknown>>,
): ChatEntry | undefined {
	const base = {
		id: Number(entry.id),
		quote: null,
		source: null,
		error: null,
		thinking: null,
		usage: null,
		stats: null,
		detail: null,
		image: false,
		step: false,
	};
	const message = entry.model?.[0];
	switch (entry.kind) {
		case "pi.user":
		case SELECTION_KIND:
		case MESSAGE_KIND:
		case INPUT_KIND:
			return {
				...base,
				role: "user",
				...inputView(entry.kind, entry.data, message?.role === "user" ? message.content : undefined),
			};
		case "pi.assistant": {
			const answer = message as AssistantMessage | undefined;
			const text = answer === undefined ? "" : messageText(answer);
			const thinking = answer === undefined ? "" : thinkingText(answer);
			// A tool call without text or thinking: its result shows instead.
			if (answer?.stopReason === "toolUse" && text === "" && thinking === "") return undefined;
			const stopped = answer?.stopReason === "aborted";
			const error =
				answer?.stopReason === "error"
					? (answer.errorMessage ?? t("requestFailed"))
					: stopped
						? t("answerStopped")
						: null;
			return {
				...base,
				role: "assistant",
				text,
				error,
				...(stopped ? { stopped: true } : {}),
				thinking: thinking === "" ? null : thinking,
				// What the model said before a tool call is a step: its answer comes after the tool.
				step: answer?.stopReason === "toolUse",
			};
		}
		case "pi.compaction":
			return { ...base, role: "notice", text: t("messagesSummarized") };
		case "pi.reset":
			return { ...base, role: "notice", text: t("newContextNotice") };
		default:
			return message?.role === "toolResult"
				? toolNotice({ ...base, step: true }, message, sources.get(message.toolCallId))
				: undefined;
	}
}

/**
 * A tool's line: an action's summary, from the model, with what pi did under it (design 6.23), so a misleading summary
 * sits next to the real action; a read or an observe names the page. `source`: the call's arguments, for a result
 * without details.
 */
function toolNotice(
	base: Pick<
		ChatEntry,
		"id" | "quote" | "source" | "error" | "thinking" | "usage" | "stats" | "detail" | "image" | "step"
	>,
	result: ToolResultMessage,
	source: Record<string, unknown> | undefined,
): ChatEntry {
	const details = result.details as
		| {
				title?: unknown;
				url?: unknown;
				pageChanged?: unknown;
				scope?: unknown;
				summary?: unknown;
				done?: unknown;
				went?: unknown;
				find?: unknown;
				code?: unknown;
				error?: unknown;
				width?: unknown;
				height?: unknown;
				element?: unknown;
				scrolled?: unknown;
				scrollStep?: unknown;
				step?: unknown;
				waited?: unknown;
		  }
		| undefined;
	const summary =
		typeof details?.summary === "string"
			? details.summary
			: typeof source?.summary === "string"
				? summaryOf(source.summary)
				: null;
	// A script's code, cut: what ran, or may have, under the model's summary of it.
	const code =
		typeof details?.code === "string"
			? details.code
			: result.toolName === "run_script" && typeof source?.code === "string"
				? codePreview(source.code)
				: null;
	if (result.isError) {
		// A script that threw: its error rather than the whole result.
		const text =
			typeof details?.error === "string"
				? details.error
				: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
		return {
			...base,
			role: "notice",
			text: summary ?? t("toolFailed", [result.toolName]),
			error: text,
			detail: code,
			// A script that threw may have changed the page before it did.
			...(result.toolName === "run_script" ? { acted: true as const } : {}),
		};
	}
	if (result.toolName === "act_on_page") {
		let done = typeof details?.done === "string" ? details.done : null;
		// A navigation in the interface language; what act_on_page added after it (opened tabs) stays as the model read it.
		if (done !== null && typeof details?.went === "string") {
			const english = details.went === "reload" ? "Reloaded the page" : `Went to ${details.went}`;
			if (done.startsWith(english))
				done =
					(details.went === "reload" ? t("reloadedPage") : t("wentTo", [details.went])) +
					done.slice(english.length);
		}
		const step = stepOf(details?.step);
		if (done !== null && step !== null) done = localized(done, step);
		// A tab switched or closed without a summary: the step is the line, and a switched tab's page under it.
		if (summary === null && (step?.kind === "switchTab" || step?.kind === "closeTab")) {
			const page =
				step.kind === "closeTab"
					? null
					: typeof details?.title === "string" && details.title !== ""
						? details.title
						: typeof details?.url === "string"
							? details.url
							: null;
			return { ...base, role: "notice", text: done ?? localStep(step), detail: page, acted: true };
		}
		return { ...base, role: "notice", text: summary ?? t("actedOnPage"), detail: done, acted: true };
	}
	if (result.toolName === "run_script")
		return {
			...base,
			role: "notice",
			text: summary ?? t("ranScript"),
			detail: code,
			acted: true,
		};
	if (result.toolName === "screenshot_page") {
		// The image stays out of the chat's state, which goes to the panel with each change: the panel asks for it.
		const image = result.content.some((block) => block.type === "image");
		const text =
			typeof details?.element === "string" ? t("tookElementScreenshot", [details.element]) : t("tookScreenshot");
		const size =
			typeof details?.width === "number" && typeof details.height === "number"
				? `${details.width} × ${details.height}`
				: null;
		const scrollStep = stepOf(details?.scrollStep);
		const scrolled =
			typeof details?.scrolled === "string"
				? scrollStep === null
					? details.scrolled
					: localized(details.scrolled, scrollStep)
				: null;
		const detail = [scrolled, size].filter((part) => part !== null).join("; ");
		return { ...base, role: "notice", text, detail: detail === "" ? null : detail, image };
	}
	const name = typeof details?.title === "string" && details.title !== "" ? details.title : details?.url;
	if (typeof name !== "string") return { ...base, role: "notice", text: result.toolName };
	if (result.toolName === "wait_on_page") {
		const waited = typeof details?.waited === "string" ? details.waited : null;
		return { ...base, role: "notice", text: t("waitedOnPage", [name]), detail: waited };
	}
	if (result.toolName === "observe_page") {
		const text =
			typeof details?.find === "string" ? t("observedPageFind", [name, details.find]) : t("observedPage", [name]);
		return { ...base, role: "notice", text };
	}
	const changed = details?.pageChanged === true ? t("pageChangedSuffix") : "";
	const read = details?.scope === "selection" ? "selection" : "page";
	const text = t(read === "selection" ? "readSelectionNotice" : "readPageNotice", [name]) + changed;
	return { ...base, role: "notice", text, read };
}

/**
 * How an input shows, from its entry kind and data and the message the model got: a typed page message as typed, and
 * a selection sent with its preset prompt unchanged as the preset and the quote.
 */
/** The inputs of a conversation's inbox, in order; queued writes are not inputs. */
export function queuedInputs(inbox: InboxState | undefined): QueuedInput[] {
	return (inbox?.items ?? []).flatMap((item) =>
		item.mode === "write"
			? []
			: [
					{
						id: Number(item.id),
						...inputView(item.entry?.kind ?? "pi.user", item.entry?.data, item.content as UserMessage["content"]),
						mode: item.mode,
					},
				],
	);
}

function inputView(
	kind: string,
	data: JsonValue | undefined,
	content: UserMessage["content"] | undefined,
): Omit<QueuedInput, "id" | "mode"> {
	const stored = storedAttachments(data, content);
	const attachments: { attachments?: AttachmentInfo[] } =
		stored === undefined ? {} : { attachments: stored.attachments };
	// The text the model read first, without the attachments' blocks.
	const sent = stored !== undefined ? stored.lead : content === undefined ? "" : contentText(content);
	// Data that names attachments its content does not match is not trusted for the text either: the input shows as
	// what the model read (design 6.42).
	const declared = typeof data === "object" && data !== null && !Array.isArray(data) && "attachments" in data;
	if (declared && stored === undefined) return { text: sent, quote: null, source: null, sent };
	if (kind === INPUT_KIND) {
		const typed =
			typeof (data as Partial<InputData> | undefined)?.text === "string" ? (data as InputData).text : sent;
		return { text: typed, quote: null, source: null, sent: typed, ...attachments };
	}
	const input = inputData(kind, data);
	if (input === undefined) return { text: sent, quote: null, source: null, sent, ...attachments };
	const source = { title: input.page.title, url: input.page.url };
	if (kind === MESSAGE_KIND) {
		const moved = movedOf((input as Partial<MessageData>).moved);
		return {
			text: promptOf(kind, input) ?? input.text,
			quote: null,
			source,
			sent: input.text,
			...(moved === undefined ? {} : { moved }),
			...attachments,
		};
	}
	// Only `false` counts as unchanged: entries stored before the flag show the prompt as sent.
	const { preset, edited } = input as Partial<SelectionEntryData>;
	const quote = edited === false && typeof preset === "string" ? { preset, text: input.text } : null;
	return { text: sent, quote, source, sent, ...attachments };
}

/** The `data` of a `web.selection` or `web.message` entry, if it has the expected page. */
export function inputData(kind: string, data: JsonValue | undefined): SelectionData | MessageData | undefined {
	if (kind !== SELECTION_KIND && kind !== MESSAGE_KIND) return undefined;
	if (typeof data !== "object" || data === null || Array.isArray(data) || typeof data.text !== "string")
		return undefined;
	const page = data.page;
	return typeof page === "object" && page !== null && !Array.isArray(page) && typeof page.tabId === "number"
		? (data as unknown as SelectionData | MessageData)
		: undefined;
}

const STEP_KINDS = new Set(["click", "type", "press", "choose", "scroll", "reveal", "switchTab", "closeTab"]);

/** A stored step (design 6.23), if it has a known kind; page-tools.ts writes the rest of its shape. */
function stepOf(step: unknown): Step | null {
	if (typeof step !== "object" || step === null) return null;
	const { kind } = step as Record<string, unknown>;
	return typeof kind === "string" && STEP_KINDS.has(kind) ? (step as Step) : null;
}

/** `done` with its step said in the interface language; what act_on_page added after it stays as the model read it. */
function localized(done: string, step: Step): string {
	const english = stepText(step);
	return done.startsWith(english) ? localStep(step) + done.slice(english.length) : done;
}

function localStep(step: Step): string {
	switch (step.kind) {
		case "click":
			return t("stepClick", [step.target]);
		case "type":
			return t(step.submitted ? "stepTypeSubmit" : "stepType", [JSON.stringify(step.text), step.target]);
		case "press":
			return step.target === null ? t("stepPress", [step.key]) : t("stepPressIn", [step.key, step.target]);
		case "choose":
			return t("stepChoose", [JSON.stringify(step.option), step.target]);
		case "scroll": {
			const direction = t(
				({ up: "stepUp", down: "stepDown", top: "stepTop", bottom: "stepBottom" } as const)[step.direction],
			);
			const line =
				step.target === null ? t("stepScrollPage", [direction]) : t("stepScrollBox", [step.target, direction]);
			return step.end === null ? line : t("stepAtEnd", [line, t(step.end === "top" ? "stepAtTop" : "stepAtBottom")]);
		}
		case "reveal":
			return t("stepReveal", [step.target]);
		case "switchTab":
			return t("stepSwitchTab", [step.tab]);
		case "closeTab": {
			const line = t(step.closed ? "stepCloseTab" : "stepTabClosed", [step.tab]);
			return step.back === null ? line : t("stepToolsMoved", [line, step.back]);
		}
	}
}

/** A stored message's move (design 6.28), if it has one of the expected shape. */
function movedOf(moved: unknown): PageMove | undefined {
	if (typeof moved !== "object" || moved === null) return undefined;
	const { url, title, site } = moved as Record<string, unknown>;
	if (typeof url === "string" && typeof title === "string") return { url, title };
	if (typeof site === "string" || site === null) return { site };
	return undefined;
}

/** The name of the page prompt a `web.message` entry was sent with unchanged (design 6.18). */
function promptOf(kind: string, data: SelectionData | MessageData): string | undefined {
	const { prompt } = data as Partial<MessageData>;
	return kind === MESSAGE_KIND && typeof prompt === "string" && prompt !== "" ? prompt : undefined;
}

/** The page of an input entry; null for an input without one. */
export function pageOf(entry: EntryRecord): PageRef | null {
	return inputData(entry.kind, entry.data)?.page ?? null;
}

/** The answer's text, without its thinking. */
function messageText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("")
		.trim();
}

/** The readable thinking; a redacted block carries only the provider's opaque payload. */
function thinkingText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "thinking" && block.redacted !== true ? [block.thinking.trim()] : []))
		.filter((text) => text !== "")
		.join("\n\n");
}

export function contentText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : t("imagePlaceholder"))).join("\n");
}
