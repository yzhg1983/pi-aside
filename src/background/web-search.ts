import {
	type Api,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { MAX_URL_CHARS } from "../shared/protocol.ts";
import { loadSettings } from "./settings.ts";

const SOURCES = "web_search_call.action.sources";
const MAX_CITATIONS = 100;

type CitedMessage = { original: string; rendered: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchTool(value: unknown): boolean {
	return record(value) && (value.type === "web_search" || value.type === "web_search_preview");
}

/** Native search adapters. OpenAI only for now; authentication does not decide search availability. */
export function openaiSearch<T extends StreamOptions>(options?: T) {
	const completed: CitedMessage[] = [];
	const sources = new Map<string, number>();
	return {
		options: {
			...options,
			onPayload: async (payload: unknown, model: Model<Api>) => {
				const changed = await options?.onPayload?.(payload, model);
				const next = changed === undefined ? payload : changed;
				if (
					model.provider !== "openai" ||
					model.api !== "openai-responses" ||
					model.baseUrl !== "https://api.openai.com/v1" ||
					!record(next)
				)
					return next;
				const { openaiWebSearch } = await loadSettings();
				const tools: unknown[] = Array.isArray(next.tools) ? next.tools : [];
				const include: unknown[] = Array.isArray(next.include) ? next.include : [];
				if (!openaiWebSearch) {
					return {
						...next,
						...(Array.isArray(next.tools) ? { tools: tools.filter((tool) => !searchTool(tool)) } : {}),
						...(Array.isArray(next.include) ? { include: include.filter((item) => item !== SOURCES) } : {}),
					};
				}
				return {
					...next,
					tools: tools.some(searchTool) ? tools : [...tools, { type: "web_search" }],
					include: include.includes(SOURCES) ? include : [...include, SOURCES],
				};
			},
			onProviderStreamEvent: async (event: unknown, model: Model<Api>) => {
				await options?.onProviderStreamEvent?.(event, model);
				if (
					model.provider !== "openai" ||
					model.api !== "openai-responses" ||
					model.baseUrl !== "https://api.openai.com/v1" ||
					!record(event)
				)
					return;
				if (event.type !== "response.output_item.done") return;
				const message = citedMessage(event.item, sources);
				if (message !== undefined) completed.push(message);
			},
		} as T,
		wrap(source: AssistantMessageEventStream): AssistantMessageEventStream {
			const out = createAssistantMessageEventStream();
			void (async () => {
				try {
					for await (const event of source) {
						if (event.type === "text_end") {
							// The raw item callback runs before the SDK emits this item's text_end.
							const message = completed.shift();
							const block = event.partial.content[event.contentIndex];
							if (message?.original === event.content && block?.type === "text") {
								block.text = message.rendered;
								out.push({ ...event, content: message.rendered });
								continue;
							}
						}
						out.push(event);
					}
				} finally {
					out.end();
				}
			})();
			return out;
		},
	};
}

/** Keep the provider's text and add numbered inline links at its citation boundaries. Never accept raw HTML. */
function citedMessage(item: unknown, sources: Map<string, number>): CitedMessage | undefined {
	if (!record(item) || item.type !== "message" || !Array.isArray(item.content)) return undefined;
	let original = "";
	let rendered = "";
	for (const part of item.content) {
		if (!record(part)) continue;
		const text = part.type === "output_text" ? part.text : part.refusal;
		if (typeof text !== "string") continue;
		original += text;
		const links: { end: number; number: number; href: string }[] = [];
		const seen = new Set<string>();
		for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
			if (links.length === MAX_CITATIONS) break;
			if (
				!record(annotation) ||
				annotation.type !== "url_citation" ||
				typeof annotation.url !== "string" ||
				annotation.url.length > MAX_URL_CHARS ||
				typeof annotation.start_index !== "number" ||
				!Number.isInteger(annotation.start_index) ||
				typeof annotation.end_index !== "number" ||
				!Number.isInteger(annotation.end_index) ||
				annotation.start_index < 0 ||
				annotation.end_index < annotation.start_index ||
				annotation.end_index > text.length
			)
				continue;
			let href: string;
			try {
				const url = new URL(annotation.url);
				if (url.protocol !== "https:" && url.protocol !== "http:") continue;
				href = url.href.replace(/[()\\<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
			} catch {
				continue;
			}
			let end = annotation.end_index;
			// A malformed boundary must not split a Unicode surrogate pair.
			const before = text.charCodeAt(end - 1);
			if (before >= 0xd800 && before <= 0xdbff) end += 1;
			const key = `${end}:${href}`;
			if (seen.has(key)) continue;
			seen.add(key);
			let number = sources.get(href);
			if (number === undefined) {
				number = sources.size + 1;
				sources.set(href, number);
			}
			links.push({ end, number, href });
		}
		let cited = text;
		for (const link of links.sort((a, b) => b.end - a.end || b.number - a.number)) {
			cited = `${cited.slice(0, link.end)} [${link.number}](${link.href})${cited.slice(link.end)}`;
		}
		rendered += cited;
	}
	return { original, rendered };
}
