// Markdown for answers, without HTML. The parser builds a tree of allowlisted elements; the panel creates DOM nodes
// from it with `createElement` and text nodes, so model output is never parsed as HTML. Raw HTML stays text, images
// become links (nothing loads by itself), and links keep only http, https, and mailto URLs.
//
// Model output is untrusted, and the panel parses the live answer on every update, so parsing has fixed bounds: at
// most MAX_DEPTH levels of nesting (deeper text stays literal), inline spans of at most 1000 characters, and no inline
// parsing of lines longer than MAX_INLINE_LINE.
//
// A fenced block whose info string is `mermaid` and whose closing fence has arrived is marked as a diagram (`mermaid`
// on its `pre`, class "mermaid" in the DOM); the panel draws it as a picture (diagram.ts). It stays code until then.

export type MdTag =
	| "p"
	| "h1"
	| "h2"
	| "h3"
	| "h4"
	| "h5"
	| "h6"
	| "pre"
	| "code"
	| "blockquote"
	| "ul"
	| "ol"
	| "li"
	| "hr"
	| "br"
	| "strong"
	| "em"
	| "del"
	| "a"
	| "table"
	| "thead"
	| "tbody"
	| "tr"
	| "th"
	| "td";

export type MdNode =
	| { type: "text"; text: string }
	| { type: "element"; tag: MdTag; children: MdNode[]; href?: string; start?: number; mermaid?: true };

/** Nesting levels of blocks, and of inlines within a block. */
const MAX_DEPTH = 16;
/** Longer lines stay text: the inline patterns cost up to about 1000 steps per character. */
const MAX_INLINE_LINE = 20_000;

const text = (value: string): MdNode => ({ type: "text", text: value });
const el = (
	tag: MdTag,
	children: MdNode[] = [],
	extra: { href?: string; start?: number; mermaid?: true } = {},
): MdNode => ({
	type: "element",
	tag,
	children,
	...extra,
});

export function parseMarkdown(source: string): MdNode[] {
	return blocks(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

function isTable(lines: string[], i: number): boolean {
	const next = lines[i + 1];
	return lines[i]!.includes("|") && next?.includes("|") === true && TABLE_RULE.test(next);
}

function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i]!;
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		RULE.test(line) ||
		QUOTE.test(line) ||
		ITEM.test(line) ||
		isTable(lines, i)
	);
}

function blocks(lines: string[], depth: number): MdNode[] {
	if (depth >= MAX_DEPTH)
		return [
			el(
				"p",
				lines.flatMap((line, index) => [...(index === 0 ? [] : [el("br")]), text(line)]),
			),
		];
	const out: MdNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (line.trim() === "") {
			i += 1;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1]!;
			const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
			const body: string[] = [];
			i += 1;
			while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
			const closed = i < lines.length;
			i += 1;
			const mermaid = closed && /^mermaid$/i.test(line.slice(fence[0].length).trim().split(/\s/)[0]!);
			out.push(el("pre", [el("code", [text(body.join("\n"))])], mermaid ? { mermaid } : {}));
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null) {
			out.push(el(`h${heading[1]!.length}` as MdTag, inline(heading[2] ?? "", depth)));
			i += 1;
			continue;
		}
		if (RULE.test(line)) {
			out.push(el("hr"));
			i += 1;
			continue;
		}
		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length && lines[i]!.trim() !== "" && (QUOTE.test(lines[i]!) || !startsBlock(lines, i))) {
				inner.push(lines[i++]!.replace(/^ {0,3}> ?/, ""));
			}
			out.push(el("blockquote", blocks(inner, depth + 1)));
			continue;
		}
		if (ITEM.test(line)) {
			i = list(lines, i, out, depth);
			continue;
		}
		if (isTable(lines, i)) {
			i = table(lines, i, out, depth);
			continue;
		}
		const paragraph: string[] = [line];
		i += 1;
		while (i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines, i)) paragraph.push(lines[i++]!);
		out.push(el("p", lines_(paragraph, depth)));
	}
	return out;
}

/** Lines of a paragraph, joined by line breaks: chat answers use single newlines as breaks. */
function lines_(lines: string[], depth: number): MdNode[] {
	return lines.flatMap((line, index) => [...(index === 0 ? [] : [el("br")]), ...inline(line.trim(), depth)]);
}

function list(lines: string[], start: number, out: MdNode[], depth: number): number {
	const first = ITEM.exec(lines[start]!)!;
	const indent = first[1]!.length;
	const ordered = /\d/.test(first[2]!);
	const items: string[][] = [];
	let loose = false;
	let i = start;
	for (;;) {
		const match = i < lines.length ? ITEM.exec(lines[i]!) : null;
		if (match === null || match[1]!.length !== indent || /\d/.test(match[2]!) !== ordered) break;
		const body = [match[3] ?? ""];
		const bodyIndent = indent + match[2]!.length + 1;
		i += 1;
		while (i < lines.length) {
			const line = lines[i]!;
			if (line.trim() === "") {
				let next = i + 1;
				while (next < lines.length && lines[next]!.trim() === "") next += 1;
				if (next < lines.length && indentOf(lines[next]!) > indent) {
					body.push("");
					i += 1;
					continue;
				}
				break;
			}
			if (indentOf(line) > indent) body.push(line.slice(Math.min(indentOf(line), bodyIndent)));
			else if (!startsBlock(lines, i)) body.push(line.trim());
			else break;
			i += 1;
		}
		if (body.includes("")) loose = true;
		items.push(body);
		// A blank line between items keeps the list going.
		let next = i;
		while (next < lines.length && lines[next]!.trim() === "") next += 1;
		const following = next < lines.length ? ITEM.exec(lines[next]!) : null;
		if (next > i && following !== null && following[1]!.length === indent && /\d/.test(following[2]!) === ordered) {
			loose = true;
			i = next;
		}
	}
	const rendered = items.map((body) => {
		const children = blocks(body, depth + 1);
		// A tight item shows its text without a paragraph around it.
		return el(
			"li",
			loose
				? children
				: children.flatMap((child) => (child.type === "element" && child.tag === "p" ? child.children : [child])),
		);
	});
	const number = Number.parseInt(first[2]!, 10);
	out.push(el(ordered ? "ol" : "ul", rendered, ordered && number !== 1 ? { start: number } : {}));
	return i;
}

function cells(line: string): string[] {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
	return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function table(lines: string[], start: number, out: MdNode[], depth: number): number {
	const header = cells(lines[start]!);
	const rows: string[][] = [];
	let i = start + 2;
	while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
	const row = (values: string[], tag: "th" | "td") =>
		el(
			"tr",
			header.map((_, index) => el(tag, inline(values[index] ?? "", depth))),
		);
	out.push(
		el("table", [
			el("thead", [row(header, "th")]),
			el(
				"tbody",
				rows.map((values) => row(values, "td")),
			),
		]),
	);
	return i;
}

// Linear per start, or bounded: a whole backtick run opens a code span (the lookahead keeps it from backtracking to a
// shorter run); a scan for a closing bracket or `>` stops at the next opener; spans are at most 1000 characters.
const INLINE = new RegExp(
	[
		String.raw`(?<escape>\\[!-/:-@[-\x60{-~])`,
		String.raw`(?<code>(?<!\x60)(?=(?<ticks>\x60+))\k<ticks>(?<codeText>[\s\S]{0,1000}?[^\x60])\k<ticks>(?!\x60))`,
		String.raw`(?<image>!\[(?<imageAlt>[^\[\]]*)\]\((?<imageUrl>(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\))`,
		String.raw`(?<link>\[(?<linkText>(?:[^\[\]]|\[[^\[\]]*\])*)\]\((?<linkUrl>(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\))`,
		String.raw`(?<autolink><(?<autoUrl>(?:https?:\/\/|mailto:)[^\s<>]+)>)`,
		String.raw`(?<url>\bhttps?:\/\/[^\s<]+)`,
		String.raw`(?<strong>(?<strongMark>\*\*|__)(?=\S)(?<strongText>[\s\S]{0,1000}?\S)\k<strongMark>)`,
		String.raw`(?<strike>~~(?=\S)(?<strikeText>[\s\S]{0,1000}?\S)~~)`,
		String.raw`(?<em>\*(?=\S)(?<emStar>[\s\S]{0,1000}?\S)\*|(?<![\p{L}\p{N}])_(?=\S)(?<emUnder>[\s\S]{0,1000}?\S)_(?![\p{L}\p{N}]))`,
	].join("|"),
	"gu",
);

/** A bare URL without the punctuation after it; a closing parenthesis stays when it closes one in the URL. */
function trimUrl(url: string): string {
	let end = url.length;
	let unmatched = [...url].reduce((count, char) => count + (char === ")" ? 1 : char === "(" ? -1 : 0), 0);
	for (;;) {
		const last = url[end - 1]!;
		if (/[.,:;"'!?*_~\]]/.test(last)) end -= 1;
		else if (last === ")" && unmatched > 0) {
			end -= 1;
			unmatched -= 1;
		} else return url.slice(0, end);
	}
}

/** An http, https, or mailto URL, normalized; anything else is not a link. */
export function safeHref(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}

function link(label: MdNode[], url: string): MdNode[] {
	const href = safeHref(url);
	return href === undefined ? label : [el("a", label, { href })];
}

function inline(source: string, depth: number): MdNode[] {
	if (depth >= MAX_DEPTH || source.length > MAX_INLINE_LINE) return source === "" ? [] : [text(source)];
	const out: MdNode[] = [];
	let last = 0;
	for (const match of source.matchAll(INLINE)) {
		const groups = match.groups!;
		if (match.index > last) out.push(text(source.slice(last, match.index)));
		last = match.index + match[0].length;
		if (groups.escape !== undefined) out.push(text(groups.escape.slice(1)));
		else if (groups.code !== undefined) out.push(el("code", [text(groups.codeText!.replace(/^ (.+) $/, "$1"))]));
		else if (groups.image !== undefined)
			out.push(...link([text(`[image${groups.imageAlt ? `: ${groups.imageAlt}` : ""}]`)], groups.imageUrl!));
		else if (groups.link !== undefined) out.push(...link(inline(groups.linkText!, depth + 1), groups.linkUrl!));
		else if (groups.autolink !== undefined) out.push(...link([text(groups.autoUrl!)], groups.autoUrl!));
		else if (groups.url !== undefined) {
			const url = trimUrl(groups.url);
			out.push(...link([text(url)], url));
			if (url.length < groups.url.length) out.push(text(groups.url.slice(url.length)));
		} else if (groups.strong !== undefined) out.push(el("strong", inline(groups.strongText!, depth + 1)));
		else if (groups.strike !== undefined) out.push(el("del", inline(groups.strikeText!, depth + 1)));
		else out.push(el("em", inline(groups.emStar ?? groups.emUnder!, depth + 1)));
	}
	if (last < source.length) out.push(text(source.slice(last)));
	return out;
}

const TEXT_BLOCKS = new Set(["p", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "th", "td"]);

/** DOM nodes for a parsed tree. Links open in a new tab without access to the panel. */
export function renderMarkdown(nodes: MdNode[], doc: Document): DocumentFragment {
	const fragment = doc.createDocumentFragment();
	const build = (node: MdNode): Node => {
		if (node.type === "text") return doc.createTextNode(node.text);
		const element = doc.createElement(node.tag);
		if (node.tag === "a" && node.href !== undefined) {
			element.setAttribute("href", node.href);
			element.setAttribute("target", "_blank");
			element.setAttribute("rel", "noopener noreferrer");
		}
		if (node.tag === "ol" && node.start !== undefined) element.setAttribute("start", String(node.start));
		if (node.mermaid) element.setAttribute("class", "mermaid");
		// Each block takes its direction from its own text, so a Hebrew or Arabic paragraph reads right to left.
		if (TEXT_BLOCKS.has(node.tag)) element.setAttribute("dir", "auto");
		for (const child of node.children) element.append(build(child));
		return element;
	};
	for (const node of nodes) fragment.append(build(node));
	return fragment;
}

/** An answer as DOM nodes; plain text if rendering fails, so one answer cannot stop the panel from rendering. */
export function renderAnswer(source: string, doc: Document): Node {
	try {
		return renderMarkdown(parseMarkdown(source), doc);
	} catch {
		return doc.createTextNode(source);
	}
}
