// Text the panel shows, as pure functions, so tests can check it without a DOM.

import { interfaceLocale, type MessageKey, t } from "../shared/i18n.ts";
import {
	type AnswerStats,
	type ChatView,
	type ModelChoice,
	type ModelInfo,
	PROVIDERS,
	type ProviderId,
	RECOMMENDED_MODELS,
	type SentThinking,
	SIGN_IN_ENDED_CODES,
	type Status,
	THINKING_LEVELS,
	type Thinking,
	type Usage,
	type WhenBusy,
} from "../shared/protocol.ts";

/** A model ID without its vendor prefix: "anthropic/claude-haiku-4.5" -> "claude-haiku-4.5". */
export function shortModel(modelId: string): string {
	return modelId.slice(modelId.lastIndexOf("/") + 1) || modelId;
}

/** A token count as pi's footer shows it: 999, 1.7k, 208k, 1.7M. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Usage as pi's footer shows it, "↑1.7k ↓208 R29k CH94.4% ~$0.0123", without the counters at 0; "" when all are 0. The
 * cost is an estimate from list prices, one sum for answers with a key and on a ChatGPT plan alike: neither is a bill
 * (design 6.21).
 */
export function usageText(usage: Usage): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if ((usage.cacheRead || usage.cacheWrite) && usage.cacheHit !== null) parts.push(`CH${percent(usage.cacheHit)}`);
	const estimate = usage.cost + usage.planCost;
	if (estimate > 0) parts.push(`~${dollars(estimate)}`);
	return parts.join(" ");
}

/** A share from 0 to 1 as "45.4%". */
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
/** 3 decimals, 4 below one cent. */
const dollars = (cost: number) => `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;

/**
 * Current context as pi's footer shows it, "28.8%/500k"; "" for a chat with nothing in its context yet, and until the
 * model catalog is available. Automatic compaction is said in the tooltip, not on the line.
 */
export function contextText(context: ChatView["context"], contextWindow: number | undefined): string {
	if (contextWindow === undefined || contextWindow <= 0 || context.tokens === 0) return "";
	const used = context.tokens === null ? "?" : percent(context.tokens / contextWindow);
	return `${used}/${formatTokens(contextWindow)}`;
}

/**
 * The tooltip of the chat's usage line: what it counts, then one row per part the line shows, with its value and its
 * symbol on the line, so "↑4.8k ↓77 R4.0k CH45.4% ~$0.011 1.8%/500k" reads row by row (design 6.21), also when its
 * context part is left out.
 */
export function usageHelp(
	usage: Usage | null,
	context: { context: ChatView["context"]; window: number | undefined },
): string {
	const rows = [t("usageChatScope")];
	if (usage !== null) {
		if (usage.input) rows.push(t("usageInput", [formatTokens(usage.input)]));
		if (usage.output) rows.push(t("usageOutput", [formatTokens(usage.output)]));
		if (usage.cacheRead) rows.push(t("usageCacheRead", [formatTokens(usage.cacheRead)]));
		if (usage.cacheWrite) rows.push(t("usageCacheWrite", [formatTokens(usage.cacheWrite)]));
		if ((usage.cacheRead || usage.cacheWrite) && usage.cacheHit !== null)
			rows.push(t("usageCacheHit", [percent(usage.cacheHit)]));
		const estimate = usage.cost + usage.planCost;
		if (estimate > 0) rows.push(t("usageCost", [dollars(estimate)]));
		if (estimate > 0 && usage.planCost > 0) rows.push(t("usagePlanCost"));
	}
	if (contextText(context.context, context.window) !== "") {
		const window = formatTokens(context.window!);
		rows.push(
			context.context.tokens === null
				? t("usageContextUnknown", [window])
				: t("usageContext", [percent(context.context.tokens / context.window!), window]),
			t("usageCompaction"),
		);
	}
	return rows.join("\n");
}

/** A duration as "850ms", "12.4s", or "1m 52s". */
export function formatDuration(ms: number): string {
	if (ms < 999.5) return `${Math.round(ms)}ms`;
	if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A share from 0 to 1 as a whole percent, never rounded up to 100%: "60%". */
const wholePercent = (share: number) => `${Math.floor(share * 100 + 1e-9)}%`;

/** Time while it runs, in whole seconds: "4s", "1m 5s". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The live answer's progress, "4s · 1 tool", which its line under it takes over when it ends (design 6.21). */
export function progressLine(progress: { startedAt: number; tools: number }, now: number): string {
	const parts = [formatElapsed(now - progress.startedAt)];
	if (progress.tools > 0) parts.push(progress.tools === 1 ? t("oneTool") : t("toolCount", [progress.tools]));
	return parts.join(" · ");
}

/** The line under an answer, "12.4s · 3 tools", without the time when it is not known; "" without either (design 6.21). */
export function answerLine(stats: AnswerStats | null): string {
	if (stats === null) return "";
	const parts: string[] = [];
	if (stats.modelMs !== null) parts.push(formatDuration(stats.modelMs + stats.toolMs));
	const calls = stats.tools.reduce((total, tool) => total + tool.calls, 0);
	if (calls > 0) parts.push(calls === 1 ? t("oneTool") : t("toolCount", [calls]));
	return parts.join(" · ");
}

/**
 * The tooltip of an answer's line: its time, its tools by name, then its tokens and cost, a blank line between them;
 * "" with none (design 6.21). "in" counts the whole prompt, the cache reads and writes too.
 */
export function answerHelp(usage: Usage | null, stats: AnswerStats | null): string {
	const sections: string[] = [];
	if (stats !== null && stats.modelMs !== null) {
		const total = formatDuration(stats.modelMs + stats.toolMs);
		sections.push(
			stats.toolMs > 0
				? t("answerTimeSplit", [total, formatDuration(stats.modelMs), formatDuration(stats.toolMs)])
				: t("answerTime", [total]),
		);
	}
	if (stats !== null && stats.tools.length > 0) {
		const rows = stats.tools.map(({ name, calls, failed }) =>
			failed > 0 ? t("toolCallsFailed", [`${name} ×${calls}`, failed]) : `${name} ×${calls}`,
		);
		sections.push([t("answerTools"), ...rows].join("\n"));
	}
	if (usage !== null) {
		const rows: string[] = [];
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		const parts: string[] = [];
		if (prompt > 0)
			parts.push(
				usage.cacheRead > 0 && usage.cacheHit !== null
					? t("tokensInCached", [formatTokens(prompt), wholePercent(usage.cacheHit)])
					: t("tokensIn", [formatTokens(prompt)]),
			);
		if (usage.cacheWrite > 0) parts.push(t("tokensCacheWrite", [formatTokens(usage.cacheWrite)]));
		if (usage.output > 0) parts.push(t("tokensOut", [formatTokens(usage.output)]));
		if (parts.length > 0) rows.push(t("answerTokens", [parts.join(" · ")]));
		const estimate = usage.cost + usage.planCost;
		if (estimate > 0) rows.push(t("answerCost", [dollars(estimate)]));
		if (estimate > 0 && usage.planCost > 0) rows.push(t("answerPlanCost"));
		if (rows.length > 0) sections.push(rows.join("\n"));
	}
	return sections.join("\n\n");
}

/** The host of a page URL for a source line; punycode stays punycode, so look-alike hosts show as such. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname || url;
	} catch {
		return url;
	}
}

/**
 * A page's address for a History row: its host, punycode as in `hostOf`, and its path, without the scheme, `www.`, the
 * query, or the fragment.
 */
export function pageAddress(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.host === "") return url;
		let path = parsed.pathname.replace(/\/+$/, "");
		try {
			path = decodeURI(path);
		} catch {
			// A path that is not UTF-8 stays encoded.
		}
		return parsed.host.replace(/^www\./, "") + path;
	} catch {
		return url;
	}
}

/**
 * The host permission that "Always allow" asks for (design 6.22): the page's scheme and host, any port. Null for a page
 * that is not http or https.
 */
export function sitePattern(url: string): string | null {
	try {
		const { protocol, hostname } = new URL(url);
		return (protocol === "https:" || protocol === "http:") && hostname !== "" ? `${protocol}//${hostname}/*` : null;
	} catch {
		return null;
	}
}

/**
 * The sites Settings lists, from Chrome's granted origins: the web page origins, one host or all hosts each, without
 * `kept` (providers, sign-in).
 */
export function allowedSites(origins: readonly string[], kept: readonly string[]): string[] {
	return origins
		.filter(
			(origin) => (origin === "<all_urls>" || /^(https?|\*):\/\/[^/]+\/\*$/.test(origin)) && !kept.includes(origin),
		)
		.toSorted();
}

/** A site as Settings shows it: its host, with the scheme when it is not https; a pattern for all hosts in words. */
export function siteName(pattern: string): string {
	if (pattern === "<all_urls>" || pattern === "*://*/*") return t("allSites");
	const [scheme = "", rest = ""] = pattern.split("://");
	const host = rest.slice(0, -2);
	if (host === "*") return t("allSchemeSites", [scheme]);
	return scheme === "https" || scheme === "*" ? host : `${scheme}://${host}`;
}

/** An origin as pi shows it: its host and port, with the scheme when it is not https. */
export function originName(origin: string): string {
	return origin.startsWith("https://") ? origin.slice("https://".length) : origin;
}

/** Whether a quote folds behind "Show more". Decided from the text, not measured: a hidden view measures 0. */
export function isLong(text: string): boolean {
	return text.length > 360 || text.split("\n").length > 6;
}

export type ComposerFacts = {
	/** The last command's error. */
	error: string | undefined;
	/** Why the draft in the composer was not sent. */
	note: string | null;
	sending: boolean;
	/** The setup card shows: the chat's provider has no key, or pi may not reach it. */
	setup: "key" | "permission" | null;
	busy: boolean;
	/** The composer has text to send. */
	hasText: boolean;
	/** What Enter does with it while busy; Alt+Enter does the other (design 6.39). */
	enter: WhenBusy;
};

/** The composer's status line, most important first, or "" when it has nothing to say. `bad`: something failed. */
export function composerStatus(facts: ComposerFacts): { text: string; tone: "bad" | "plain" } {
	if (facts.error !== undefined) return { text: facts.error, tone: "bad" };
	if (facts.note !== null) return { text: t("notSentReason", [facts.note]), tone: "bad" };
	if (facts.sending) return { text: t("sending"), tone: "plain" };
	if (facts.setup !== null)
		return { text: facts.setup === "key" ? t("addKeySend") : t("allowAccessSend"), tone: "plain" };
	if (facts.busy && facts.hasText)
		return { text: t(facts.enter === "steer" ? "enterSteers" : "enterFollowsUp"), tone: "plain" };
	if (facts.busy) return { text: t("escStops"), tone: "plain" };
	return { text: "", tone: "plain" };
}

/** What a Verify result means, where its name does not say. */
const VERIFY_NOTES: Record<string, MessageKey> = {
	expired: "verifyExpiredNote",
	forbidden: "verifyForbiddenNote",
	limited: "verifyLimitedNote",
};
const VERIFY_LABELS: Record<string, MessageKey> = {
	accepted: "verifyAccepted",
	rejected: "verifyRejected",
	expired: "verifyExpired",
	forbidden: "verifyForbidden",
	limited: "verifyLimited",
	no_permission: "verifyNoPermission",
	no_key: "verifyNoKey",
	network_error: "verifyNetworkError",
	timeout: "verifyTimeout",
};

/**
 * A Verify result: "accepted", or what went wrong, "rejected (HTTP 401)". `ok`: true when accepted, null when the
 * result proves nothing about sends, false otherwise.
 */
export function verifyText(check: { result: string; status?: number }): { text: string; ok: boolean | null } {
	const note = VERIFY_NOTES[check.result];
	const label = VERIFY_LABELS[check.result];
	const text = `${label === undefined ? check.result.replace("_", " ") : t(label)}${check.status ? ` (HTTP ${check.status})` : ""}${note ? `: ${t(note)}` : ""}`;
	return { text, ok: check.result === "accepted" ? true : check.result === "forbidden" ? null : false };
}

/**
 * An answer's error. OpenAI's usage-limit error for a ChatGPT sign-in gets OpenAI's words and a "Manage usage" link. A
 * refresh failure, "OAuth refresh failed for openai: OpenAI sign-in failed (400: invalid_grant)" from pi-ai, says
 * Sign in again for a code that ends the session, else points to Verify (design 6.20).
 */
export function answerError(error: string): { text: string; usage: boolean } {
	if (error.includes("subscription_sharing_usage_limit_exceeded")) {
		return { text: t("planUsageLimit"), usage: true };
	}
	if (error.startsWith("OAuth refresh failed for openai")) {
		const code = /\(\d+: ([^)]+)\)$/.exec(error)?.[1];
		const ended = code !== undefined && SIGN_IN_ENDED_CODES.includes(code);
		return {
			text: ended ? t("signInEnded") : t("signInRenewFailed"),
			usage: false,
		};
	}
	return { text: error, usage: false };
}

// Settings > Providers.

export type ProviderFacts = {
	/** A key or a ChatGPT sign-in is saved. */
	key: boolean;
	/** Chrome lets pi reach the provider. */
	permission: boolean;
	/** The saved credential is a ChatGPT sign-in. */
	plan: boolean;
	/** OpenAI ended the sign-in. */
	ended: boolean;
	/** A ChatGPT sign-in waits for its callback. */
	waiting: boolean;
};

/** A provider row's status, in a word or two, and its dot: `ok` sends, `warn` needs the user, `unset` is not set up. */
export function providerStatus(facts: ProviderFacts): { text: string; tone: "ok" | "warn" | "unset" } {
	if (!facts.key) return { text: facts.waiting ? t("waitingSignIn") : t("notSetUp"), tone: "unset" };
	if (facts.ended) return { text: t("signInEndedShort"), tone: "warn" };
	if (!facts.permission) return { text: t("needsAccess"), tone: "warn" };
	return { text: facts.plan ? t("chatGPTPlan") : t("ready"), tone: "ok" };
}

// The model picker in the message box.

/** The catalog without the OpenAI models that a ChatGPT sign-in's plan does not offer (design 6.20). */
export function offeredModels(models: readonly ModelInfo[], access: Status["access"]): ModelInfo[] {
	const { plan, planModels } = access.openai;
	if (!plan || planModels === null) return [...models];
	return models.filter((model) => model.provider !== "openai" || planModels.includes(model.id));
}

export function sameModel(a: ModelChoice, b: ModelChoice): boolean {
	return a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * Models of the providers in `keyed` whose name or `provider/model` contains every word of the filter, in catalog
 * order. So "haiku" finds Haiku at each provider, and "anthropic/" Anthropic's models and OpenRouter's Anthropic ones.
 */
export function filterModels(
	models: readonly ModelInfo[],
	keyed: ReadonlySet<ProviderId>,
	filter: string,
): ModelInfo[] {
	const words = filter
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== "");
	return models.filter((model) => {
		// A line break between the two: a word must not match across them.
		const text = `${model.name}\n${model.provider}/${model.id}`.toLowerCase();
		return keyed.has(model.provider) && words.every((word) => text.includes(word));
	});
}

/** A model's name without "Vendor: " when its ID names the vendor, which the row shows under it. */
export function modelName(model: ModelInfo): string {
	const colon = model.name.indexOf(": ");
	return model.id.includes("/") && colon > 0 ? model.name.slice(colon + 2) : model.name;
}

export function modelTags(model: ModelInfo, current: ModelChoice): ("current" | "recommended")[] {
	const tags: ("current" | "recommended")[] = [];
	if (sameModel({ provider: model.provider, modelId: model.id }, current)) tags.push("current");
	if (RECOMMENDED_MODELS[model.provider] === model.id) tags.push("recommended");
	return tags;
}

export type ModelFacts = {
	selected: ModelChoice | undefined;
	/** The chat's model. */
	current: ModelChoice;
	/** Whether the selected model's provider has a key. */
	hasKey: boolean;
	/** The chat runs or has queued inputs: the worker refuses another model then. */
	busy: boolean;
};

/** Whether picking the selected model changes the chat's, and if not, why. The worker still refuses a change while the chat is busy. */
export function useModelState(facts: ModelFacts): { enabled: boolean; reason: string } {
	const { selected, current } = facts;
	if (selected === undefined) return { enabled: false, reason: "" };
	if (sameModel(selected, current)) return { enabled: false, reason: t("chatUsesModel") };
	if (!facts.hasKey) return { enabled: false, reason: t("addProviderKeyFirst", [PROVIDERS[selected.provider].name]) };
	if (facts.busy) return { enabled: false, reason: t("waitOrStopAnswer") };
	return { enabled: true, reason: "" };
}

// History: rows under Today, Yesterday, Previous 7 days, and Earlier, each with a short time.

export const HISTORY_GROUPS = ["Today", "Yesterday", "Previous 7 days", "Earlier"] as const;
export type HistoryGroup = (typeof HISTORY_GROUPS)[number];

/** Local midnight `days` calendar days before `now`'s day. Not `now - days * 24 h`: a DST day has 23 or 25 hours. */
function dayStart(now: number, days: number): number {
	const date = new Date(now);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - days).getTime();
}

/** The group of a chat started at `createdAt`. A time after `now`, from a clock change, counts as today. */
export function historyGroup(createdAt: number, now: number): HistoryGroup {
	if (createdAt >= dayStart(now, 0)) return "Today";
	if (createdAt >= dayStart(now, 1)) return "Yesterday";
	if (createdAt >= dayStart(now, 6)) return "Previous 7 days";
	return "Earlier";
}

/**
 * Chats under their group, in list order (newest first). A row never takes a newer group than the row above it, so a
 * clock change cannot repeat a header.
 */
export function groupChats<T extends { createdAt: number }>(
	chats: readonly T[],
	now: number,
): { group: HistoryGroup; chats: T[] }[] {
	const groups: { group: HistoryGroup; chats: T[] }[] = [];
	let oldest = 0;
	for (const chat of chats) {
		oldest = Math.max(oldest, HISTORY_GROUPS.indexOf(historyGroup(chat.createdAt, now)));
		const group = HISTORY_GROUPS[oldest]!;
		const last = groups.at(-1);
		if (last?.group === group) last.chats.push(chat);
		else groups.push({ group, chats: [chat] });
	}
	return groups;
}

/** "now", "20 min", or "3 h" today; the time yesterday; the weekday in the last 7 days; else the date. */
export function historyTime(createdAt: number, now: number, locale: string = interfaceLocale()): string {
	const date = new Date(createdAt);
	switch (historyGroup(createdAt, now)) {
		case "Today": {
			const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
			return minutes < 1
				? t("timeNow")
				: minutes < 60
					? t("timeMinutes", [minutes])
					: t("timeHours", [Math.floor(minutes / 60)]);
		}
		case "Yesterday":
			return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
		case "Previous 7 days":
			return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
		case "Earlier": {
			const year = date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
			return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...year }).format(date);
		}
	}
}

/**
 * The note on a chat that the tab found by its page: "Continued a chat started 20 min ago", "... yesterday at 9:05 AM",
 * "... on Mon", "... on Oct 3".
 */
export function resumedText(createdAt: number, now: number, locale?: string): string {
	const time = historyTime(createdAt, now, locale);
	switch (historyGroup(createdAt, now)) {
		case "Today":
			return Math.max(0, now - createdAt) < 60_000 ? t("resumedNow") : t("resumedAgo", [time]);
		case "Yesterday":
			return t("resumedYesterday", [time]);
		default:
			return t("resumedOn", [time]);
	}
}

/** The thinking levels' names, in English in every language: they are the providers' effort names (design 6.36). */
export const THINKING_NAMES: Record<Exclude<SentThinking, "default">, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/**
 * The thinking picker for the chat's model (design 6.16, 6.35): disabled for a model the catalog says cannot think,
 * since pi-ai sends it no level. A level the model lacks is greyed out and says what the model gets instead; the
 * setting keeps it, so a model that has it uses it again. A model not in the catalog, or before it loaded, keeps every
 * level.
 */
export function thinkingPicker(
	model: ModelInfo | undefined,
	level: Thinking,
): { enabled: boolean; title: string; levels: Record<Thinking, { enabled: boolean; title: string }> } {
	const levels = Object.fromEntries(
		THINKING_LEVELS.map((each) => [
			each,
			// Off stays selectable: on a model that cannot turn thinking off it still sends no level.
			{
				enabled: each === "off" || model === undefined || model.thinking[each] === each,
				title: model === undefined ? "" : thinkingNote(model, each),
			},
		]),
	) as Record<Thinking, { enabled: boolean; title: string }>;
	if (model?.reasoning === false) return { enabled: false, title: t("modelNoThinking", [modelName(model)]), levels };
	const notes = [levels[level].title, level === "max" ? t("thinkingMaxHelp") : ""].filter((note) => note !== "");
	return { enabled: true, title: [t("thinkingHelp", [THINKING_NAMES[level]]), ...notes].join(" "), levels };
}

/** Why `model` does not get `level` as is, or "". */
function thinkingNote(model: ModelInfo, level: Thinking): string {
	const sent = model.thinking[level];
	if (!model.reasoning || sent === level) return "";
	if (sent === "default") return t("thinkingNoOff", [modelName(model)]);
	return t("thinkingMoved", [modelName(model), THINKING_NAMES[level], THINKING_NAMES[sent]]);
}

/** A file name from a chat's title: no characters a file system refuses, at most 80 characters; "pi chat" if none left. */
export function fileName(title: string): string {
	const name = title
		.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80)
		.trim();
	return name === "" || /^\.+$/.test(name) ? "pi chat" : name;
}
