import { expect, it } from "vitest";
import { type MdNode, parseMarkdown, renderAnswer, renderMarkdown, safeHref } from "../src/panel/markdown.ts";

/** A compact HTML-like rendering of the tree, for assertions. Text is shown escaped, as the DOM would hold it. */
function html(nodes: MdNode[]): string {
	return nodes
		.map((node) => {
			if (node.type === "text") return node.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
			const attributes = `${node.href === undefined ? "" : ` href="${node.href}"`}${node.start === undefined ? "" : ` start="${node.start}"`}${node.mermaid ? ' class="mermaid"' : ""}`;
			return node.tag === "br" || node.tag === "hr"
				? `<${node.tag}>`
				: `<${node.tag}${attributes}>${html(node.children)}</${node.tag}>`;
		})
		.join("");
}

const md = (source: string) => html(parseMarkdown(source));

it("renders the common blocks", () => {
	expect(md("# Title\n\nSome **bold**, *em*, ~~old~~ and `code`.")).toBe(
		"<h1>Title</h1><p>Some <strong>bold</strong>, <em>em</em>, <del>old</del> and <code>code</code>.</p>",
	);
	expect(md("```ts\nconst a = 1;\n\nconst b = 2;\n```")).toBe("<pre><code>const a = 1;\n\nconst b = 2;</code></pre>");
	expect(md("> quoted\n> more")).toBe("<blockquote><p>quoted<br>more</p></blockquote>");
	expect(md("one\ntwo\n\n---\n\nthree")).toBe("<p>one<br>two</p><hr><p>three</p>");
	expect(md("| a | b |\n|---|:-:|\n| 1 | x \\| y |")).toBe(
		"<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>x | y</td></tr></tbody></table>",
	);
});

it("renders lists, nested and numbered", () => {
	expect(md("- a\n- b\n  - c\n\n3. three\n4. four")).toBe(
		'<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol>',
	);
	expect(md("1. first\n\n2. second")).toBe("<ol><li><p>first</p></li><li><p>second</p></li></ol>");
	expect(md("- item\n  ```\n  code\n  ```")).toBe("<ul><li>item<pre><code>code</code></pre></li></ul>");
});

it("keeps HTML as text", () => {
	// The tag stays text; only its URL becomes an ordinary link, so nothing loads.
	expect(md('<img src="https://e.com/x.png" onerror="alert(1)">')).toBe(
		'<p>&lt;img src="<a href="https://e.com/x.png">https://e.com/x.png</a>" onerror="alert(1)"></p>',
	);
	expect(md("<script>alert(1)</script>\n\n```html\n<b>x</b>\n```")).toBe(
		"<p>&lt;script>alert(1)&lt;/script></p><pre><code>&lt;b>x&lt;/b></code></pre>",
	);
});

it("links only http, https, and mailto URLs; images become links", () => {
	expect(md("[a](https://e.com/p?q=1) [b](javascript:alert(1)) [c](data:text/html,x) [d](mailto:x@e.com)")).toBe(
		'<p><a href="https://e.com/p?q=1">a</a> b c <a href="mailto:x@e.com">d</a></p>',
	);
	expect(md("![chart](https://e.com/c.png) ![x](file:///etc/passwd)")).toBe(
		'<p><a href="https://e.com/c.png">[image: chart]</a> [image: x]</p>',
	);
	expect(md("See https://e.com/a_(b). And (https://e.com/y), <https://e.com/z>.")).toBe(
		'<p>See <a href="https://e.com/a_(b)">https://e.com/a_(b)</a>. And (<a href="https://e.com/y">https://e.com/y</a>), <a href="https://e.com/z">https://e.com/z</a>.</p>',
	);
	expect(safeHref("JaVaScRiPt:alert(1)")).toBeUndefined();
	expect(safeHref(" https://e.com")).toBe("https://e.com/");
	expect(safeHref("/relative")).toBeUndefined();
});

it("leaves underscores inside words and escaped markers alone", () => {
	expect(md("snake_case_name and \\*not em\\*")).toBe("<p>snake_case_name and *not em*</p>");
	expect(md("**unclosed and `unclosed")).toBe("<p>**unclosed and `unclosed</p>");
});

it("renders a partial answer while it streams", () => {
	expect(md("Here:\n\n```js\nconst a")).toBe("<p>Here:</p><pre><code>const a</code></pre>");
	expect(md("- one\n- tw")).toBe("<ul><li>one</li><li>tw</li></ul>");
});

it("parses crafted answers in bounded time", () => {
	const n = 20_000;
	const crafted = [
		`prefix ${"`".repeat(n)}`,
		"` a".repeat(n / 3),
		"**a ".repeat(n / 4),
		"*a ".repeat(n / 3),
		"~~a ".repeat(n / 4),
		"[a[b".repeat(n / 4),
		"![a".repeat(n / 3),
		"<http://a".repeat(n / 9),
		`http://a${")".repeat(n)}`,
		"**a ".repeat(100_000),
	];
	const start = performance.now();
	for (const source of crafted) parseMarkdown(source);
	// About 100 ms today; the unbounded patterns took seconds for one of these.
	expect(performance.now() - start).toBeLessThan(2000);
	expect(md(`See http://e.com/a)${")".repeat(3)}.`)).toBe(
		'<p>See <a href="http://e.com/a">http://e.com/a</a>)))).</p>',
	);
});

it("marks closed mermaid fences as diagrams, and only those", () => {
	expect(md("```mermaid\ngraph TD\n  A --> B\n```")).toBe(
		'<pre class="mermaid"><code>graph TD\n  A --> B</code></pre>',
	);
	expect(md("~~~~ Mermaid title\nA\n~~~~\n\nafter")).toBe('<pre class="mermaid"><code>A</code></pre><p>after</p>');
	// Still streaming: no closing fence yet.
	expect(md("```mermaid\ngraph TD\n  A -")).toBe("<pre><code>graph TD\n  A -</code></pre>");
	expect(md("```mermaidx\nA\n```\n\n```\nmermaid\n```\n\n``` js mermaid\nA\n```")).toBe(
		"<pre><code>A</code></pre><pre><code>mermaid</code></pre><pre><code>A</code></pre>",
	);
});

/** Just enough of `Document` for `renderMarkdown`. */
type FakeNode = { name: string; text?: string; attributes: Record<string, string>; children: FakeNode[] };
function fakeNode(name: string, text?: string) {
	const node = {
		name,
		...(text === undefined ? {} : { text }),
		attributes: {} as Record<string, string>,
		children: [] as FakeNode[],
		setAttribute: (key: string, value: string) => {
			node.attributes[key] = value;
		},
		append: (child: FakeNode) => {
			node.children.push(child);
		},
	};
	return node;
}
const fakeDocument = {
	createDocumentFragment: () => fakeNode("#fragment"),
	createElement: (name: string) => fakeNode(name),
	createTextNode: (text: string) => fakeNode("#text", text),
} as unknown as Document;

const depthOf = (node: FakeNode): number => 1 + Math.max(0, ...node.children.map(depthOf));

it("deep nesting stays literal past a fixed depth, and renders", () => {
	const quotes = parseMarkdown(`${">".repeat(5000)} x`);
	const tree = renderMarkdown(quotes, fakeDocument) as unknown as FakeNode;
	expect(depthOf(tree)).toBeLessThan(40);
	expect(JSON.stringify(tree)).toContain(`${">".repeat(100)}`);

	const list = Array.from({ length: 200 }, (_, level) => `${"  ".repeat(level)}- item ${level}`).join("\n");
	expect(depthOf(renderMarkdown(parseMarkdown(list), fakeDocument) as unknown as FakeNode)).toBeLessThan(60);
	expect(html(parseMarkdown(list))).toContain("item 199");
});

it("renders links with a new-tab target and no opener, and falls back to text", () => {
	const tree = renderMarkdown(parseMarkdown("[a](https://e.com)\n\n3. x"), fakeDocument) as unknown as FakeNode;
	const [paragraph, list] = tree.children;
	expect(paragraph!.children[0]).toMatchObject({
		name: "a",
		attributes: { href: "https://e.com/", target: "_blank", rel: "noopener noreferrer" },
	});
	expect(list).toMatchObject({ name: "ol", attributes: { start: "3" } });
	const diagram = renderMarkdown(parseMarkdown("```mermaid\nA\n```"), fakeDocument) as unknown as FakeNode;
	expect(diagram.children[0]).toMatchObject({ name: "pre", attributes: { class: "mermaid" } });
	expect(paragraph).toMatchObject({ name: "p", attributes: { dir: "auto" } });

	const broken = {
		createDocumentFragment: () => {
			throw new Error("broken");
		},
		createTextNode: (text: string) => fakeNode("#text", text),
	} as unknown as Document;
	expect(renderAnswer("**x**", broken)).toMatchObject({ name: "#text", text: "**x**" });
});
