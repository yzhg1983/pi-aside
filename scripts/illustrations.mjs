// The README's two drawn images, in English and Chinese: an overview banner, and an animation of pi at work beside a
// page. Both are SVG drawn from shapes and text, not screenshots: they stay sharp at any size and do not go out of date
// with the sites. The animation is CSS in the SVG, which GitHub plays in an <img>; with reduced motion it shows its
// last frame. Fonts are the viewer's system fonts.
// Run: npm run illustrations   (writes docs/images/)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../docs/images/", import.meta.url));
mkdirSync(out, { recursive: true });

const FONT =
	"ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SERIF = "Georgia, 'Times New Roman', serif";
const BLUE = "#3157d5";
const LIGHT_BLUE = "#6f8ff0";
const NAVY = ["#1d2858", "#111936"];
const YELLOW = "#ffe08a";
const INK = "#1f2937";
const MUTED = "#6b7280";
const LINE = "#d6dae3";

const TEXT = {
	en: {
		file: "",
		overview: {
			label: "pi-aside: an AI agent beside every page. It reads the page, operates it, runs scripts, asks first, and uses your own key. Beside it, an essay whose claims pi marked up in place, two flagged as having no source.",
			tagline: "An AI agent beside every page.",
			chips: ["Reads the page", "Operates the page", "Runs scripts", "Asks first", "Your own key"],
			providers: [
				"Your ChatGPT plan, or an OpenRouter, OpenAI, Anthropic, or DeepSeek key.",
				"No pi-aside server: requests go straight to your provider.",
			],
			title: "The four-day week works",
			ask: ["Mark the claims, and flag", "any without a source."],
			steps: ["Read the page", "Ran a script: 5 marks, 2 notes"],
			answer: "2 of 5 claims cite no source.",
			note: "No source",
		},
		agent: {
			label: "pi-aside beside Wikipedia's list of highest-grossing films: it reads the table, asks before running a script, marks the 2020s rows on the page, and charts the films by decade",
			head: "Ask once.",
			headRest: " See every step.",
			ask: ["When did these come out? Chart them", "by decade, and mark the 2020s."],
			read: "Read the page: 50 rows, 6 columns",
			card: "Run a script on en.wikipedia.org?",
			allow: "Allow",
			deny: "Deny",
			ran: "Ran a script: counted 50, marked 14",
			answer: [
				[
					["32 of 50", true],
					[" came out in the 2010s;", false],
				],
				[
					["the ", false],
					["14", true],
					[" from the 2020s are marked.", false],
				],
			],
			chart: "Films per decade",
			footer: "Illustration: the model's replies are scripted",
		},
	},
	zh_CN: {
		file: "zh-CN-",
		overview: {
			label: "pi-aside：每个网页旁的 AI 智能体。读懂网页、操作网页、运行脚本、先问再做，用你自己的密钥。旁边是一篇文章，pi 直接在页面上标出了其中的论断，并注明两处没有出处。",
			tagline: "每个网页旁的 AI 智能体。",
			chips: ["读懂网页", "操作网页", "运行脚本", "先问再做", "用你自己的密钥"],
			providers: [
				"ChatGPT 订阅，或 OpenRouter、OpenAI、Anthropic、DeepSeek 的 API 密钥。",
				"没有 pi-aside 服务器：请求直接发往模型服务商。",
			],
			title: "The four-day week works",
			ask: ["标出文中的论断，", "没有出处的单独注明。"],
			steps: ["已读取页面", "已运行脚本：5 处标记，2 条批注"],
			answer: "5 个论断里有 2 个没有出处。",
			note: "无出处",
		},
		agent: {
			label: "pi-aside 在维基百科的全球最高票房电影列表旁：读表格，运行脚本前先询问，在页面上标出 2020 年代的行，再按年代画出图表",
			head: "问一次，",
			headRest: "每一步都看得见。",
			ask: ["这些电影是哪年上映的？按年代", "画张图，并把 2020 年代的标出来。"],
			read: "已读取页面：50 行，6 列",
			card: "在 en.wikipedia.org 上运行脚本？",
			allow: "允许",
			deny: "拒绝",
			ran: "已运行脚本：统计 50 部，标出 14 部",
			answer: [
				[
					["50 部里有 32 部", true],
					["是 2010 年代上映的；", false],
				],
				[
					["页面上标出了 2020 年代的 ", false],
					["14", true],
					[" 部。", false],
				],
			],
			chart: "各年代上映部数",
			footer: "示意图：模型的回复为预设内容",
		},
	},
};

const esc = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** About how wide `text` is at `size`: CJK characters are square, Latin ones about half as wide. */
const width = (text, size) => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.56), 0) * size;
const svg = (w, h, label, defs, style, body) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${NAVY[0]}"/><stop offset="1" stop-color="${NAVY[1]}"/></linearGradient>
<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="60"/></filter>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.45"/></filter>
${defs}</defs>
${style ? `<style>\n${style}\n</style>\n` : ""}<rect width="${w}" height="${h}" rx="18" fill="url(#bg)"/>
<g font-family="${FONT}">
${body.join("\n")}
</g>
</svg>
`;
/** The π tile and the panel bar of the icon, `size` high. */
const logo = (x, y, size) => {
	const r = size * 0.26;
	return [
		`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${BLUE}"/>`,
		`<text x="${x + size / 2}" y="${y + size * 0.72}" text-anchor="middle" font-size="${size * 0.64}" font-weight="700" fill="#fff">π</text>`,
		`<rect x="${x + size * 1.12}" y="${y}" width="${size * 0.27}" height="${size}" rx="${size * 0.135}" fill="${LIGHT_BLUE}"/>`,
	];
};
/** A browser window with a page and the side panel; returns the panel's left edge. */
const window_ = (body, { x0, y0, x1, y1, split, url, size = 12.5 }) => {
	body.push(
		`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="14" fill="#fff" filter="url(#shadow)"/>`,
	);
	body.push(
		`<path d="M${x0} ${y0 + 14} a14 14 0 0 1 14 -14 H${x1 - 14} a14 14 0 0 1 14 14 V${y0 + 40} H${x0} Z" fill="#e8ebf3"/>`,
	);
	["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
		body.push(`<circle cx="${x0 + 22 + i * 20}" cy="${y0 + 20}" r="6" fill="${color}"/>`);
	});
	body.push(
		`<rect x="${x0 + 100}" y="${y0 + 9}" width="${Math.min(420, x1 - x0 - 130)}" height="22" rx="11" fill="#fff"/>`,
	);
	body.push(`<text x="${x0 + 116}" y="${y0 + 25}" font-size="${size}" fill="${MUTED}">${esc(url)}</text>`);
	body.push(`<path d="M${split} ${y0 + 40} H${x1} V${y1 - 14} a14 14 0 0 1 -14 14 H${split} Z" fill="#f4f6fb"/>`);
	body.push(`<rect x="${split}" y="${y0 + 40}" width="2" height="${y1 - y0 - 40}" fill="${BLUE}"/>`);
};

// --- Overview: the name, what pi does, and the product, still -------------------------------------------------------

const ICONS = [
	// A page.
	"M4 1.5h6l3 3v10H4z M6.5 7.5h4 M6.5 10.5h4",
	// A pointer.
	"M4 2l9 5.2-4.2 1.1L6.6 12.6z",
	// Code.
	"M5.5 4 2 8l3.5 4 M10.5 4 14 8l-3.5 4 M9.2 2.8 6.8 13.2",
	// A shield with a check.
	"M8 1.5l5.5 2.2v3.8c0 3.4-2.3 5.8-5.5 7-3.2-1.2-5.5-3.6-5.5-7V3.7z M5.6 8l1.7 1.7 3.2-3.4",
	// A key.
	"M5.2 7.8a3.2 3.2 0 1 0 0.01 0z M7.6 9.1 14 2.7 M12.2 4.5l1.6 1.6 M10.4 6.3l1.4 1.4",
];

/** The panel's question, right-aligned, and the top of what follows it. */
const panelAsk = (o, box, lines) => {
	const right = box.x1 - 14;
	const w = Math.max(...lines.map((line) => width(line, 13))) + 26;
	o(
		`<rect x="${right - w}" y="${box.y0 + 54}" width="${w}" height="${18 + lines.length * 18}" rx="12" fill="${BLUE}"/>`,
	);
	lines.forEach((line, i) => {
		o(`<text x="${right - w + 13}" y="${box.y0 + 75 + i * 18}" font-size="13" fill="#fff">${esc(line)}</text>`);
	});
	return box.y0 + 72 + lines.length * 18 + 18;
};
const checked = (o, x, y, label) => {
	o(`<circle cx="${x + 5}" cy="${y}" r="6" fill="#e6f4ec" stroke="#2f9e66" stroke-width="1.3"/>`);
	o(
		`<path d="M${x + 2.3} ${y} l1.9 1.9 3.4-3.6" fill="none" stroke="#2f9e66" stroke-width="1.4" stroke-linecap="round"/>`,
	);
	o(`<text x="${x + 18}" y="${y + 4}" font-size="12.5" fill="${MUTED}">${esc(label)}</text>`);
};

/** Checked steps joined by a rail; returns the y below the last. */
const steps = (o, x, y, labels) => {
	if (labels.length > 1)
		o(`<rect x="${x + 4.3}" y="${y}" width="1.4" height="${(labels.length - 1) * 26}" fill="${LINE}"/>`);
	labels.forEach((label, i) => {
		checked(o, x, y + i * 26, label);
	});
	return y + labels.length * 26;
};

/** An essay a script marked up in place: claims highlighted, two with a note; the panel says what it found. */
function essay(o, box, text) {
	const x = box.x0 + 20;
	o(
		`<text x="${x}" y="${box.y0 + 74}" font-size="17" font-weight="700" fill="${INK}" font-family="${SERIF}">${esc(text.title)}</text>`,
	);
	const lines = [
		[208, null],
		[196, "#ffe08a"],
		[204, null],
		[150, null],
		[0, 0],
		[206, null],
		[188, "#ffe08a"],
		[198, "#ffc9c9"],
		[120, null],
		[0, 0],
		[202, null],
		[176, "#ffc9c9"],
		[204, "#ffe08a"],
	];
	let y = box.y0 + 98;
	for (const [w, mark] of lines) {
		if (w === 0) {
			y += 10;
			continue;
		}
		if (mark) o(`<rect x="${x - 3}" y="${y - 5}" width="${w + 6}" height="15" rx="3" fill="${mark}"/>`);
		o(
			`<rect x="${x}" y="${y}" width="${w}" height="6" rx="3" fill="${mark ? "#8a7a50" : "#d3d8e1"}" opacity="${mark ? 0.55 : 1}"/>`,
		);
		y += 19;
	}
	// Two margin notes the script added.
	const note = (ny, label, color) => {
		const w = width(label, 11) + 16;
		o(
			`<g transform="rotate(-3 ${box.split - 14 - w} ${ny})"><rect x="${box.split - 14 - w}" y="${ny}" width="${w}" height="20" rx="3" fill="${color}" stroke="#00000014"/>`,
		);
		o(
			`<text x="${box.split - 6 - w}" y="${ny + 14}" font-size="11" font-weight="600" fill="#7a2e2e">${esc(label)}</text></g>`,
		);
	};
	note(box.y0 + 214, text.note, "#ffe1e1");
	note(box.y0 + 290, text.note, "#ffe1e1");
	const left = box.split + 16;
	let py = panelAsk(o, box, text.ask);
	py = steps(o, left, py, text.steps) + 8;
	o(`<text x="${left}" y="${py}" font-size="13.5" font-weight="700" fill="${INK}">${esc(text.answer)}</text>`);
	for (const [i, w] of [200, 170, 186].entries()) {
		o(`<rect x="${left}" y="${py + 16 + i * 16}" width="${w}" height="7" rx="3.5" fill="#dfe3ea"/>`);
	}
	o(
		`<rect x="${left}" y="${box.y1 - 40}" width="${box.x1 - 14 - left}" height="28" rx="14" fill="#fff" stroke="${LINE}"/>`,
	);
}

function overview(locale) {
	const text = TEXT[locale].overview;
	const body = [];
	const o = (line) => body.push(line);
	const W = 1200;
	const H = 440;
	o(`<circle cx="1060" cy="30" r="260" fill="${BLUE}" opacity="0.2" filter="url(#blur)"/>`);
	o(`<circle cx="80" cy="460" r="220" fill="${LIGHT_BLUE}" opacity="0.12" filter="url(#blur)"/>`);
	body.push(...logo(64, 64, 58));
	o(`<text x="152" y="111" font-size="50" font-weight="700" fill="#fff" letter-spacing="-1">pi-aside</text>`);
	o(
		`<text x="64" y="182" font-size="30" font-weight="600" fill="#fff" letter-spacing="-0.4">${esc(text.tagline)}</text>`,
	);
	// The chips, wrapped to the left column.
	let x = 64;
	let y = 214;
	text.chips.forEach((label, i) => {
		const w = 46 + width(label, 15);
		if (x + w > 600) {
			x = 64;
			y += 46;
		}
		o(
			`<rect x="${x}" y="${y}" width="${w}" height="36" rx="18" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.18"/>`,
		);
		o(
			`<path transform="translate(${x + 14} ${y + 10})" d="${ICONS[i]}" fill="none" stroke="#9fb3ff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
		);
		o(`<text x="${x + 38}" y="${y + 23.5}" font-size="15" fill="#fff">${esc(label)}</text>`);
		x += w + 10;
	});
	text.providers.forEach((line, i) => {
		o(`<text x="64" y="${y + 84 + i * 22}" font-size="14" fill="#8f9cc6">${esc(line)}</text>`);
	});

	// The product: a page, and the panel that worked on it.
	const box = { x0: 640, y0: 54, x1: 1156, y1: 392, split: 892, url: "example.org/essays/four-day-week", size: 12 };
	window_(body, box);
	essay(o, box, text);
	return svg(W, H, text.label, "", "", body);
}

// --- Agent: one question, every step, the page marked, the chart --------------------------------------------------

const T = 11;
const pct = (s) => `${((s / T) * 100).toFixed(2)}%`;
const END = [pct(T - 0.7), pct(T - 0.35)];

function agent(locale) {
	const text = TEXT[locale].agent;
	const css = [];
	const body = [];
	const o = (line) => body.push(line);
	/** Hidden until `start`, then shown until `end` or the loop's end; optionally sliding up `slide` px. */
	const show = (name, start, end, slide = 0) => {
		const [c, d] = end === undefined ? END : [pct(end), pct(end + 0.25)];
		const from = slide ? ` transform: translateY(${slide}px);` : "";
		const to = slide ? " transform: translateY(0);" : "";
		css.push(
			`@keyframes ${name} { 0%, ${pct(start)} { opacity: 0;${from} } ${pct(start + 0.35)}, ${c} { opacity: 1;${to} } ${d}, 100% { opacity: 0; } } .${name} { animation: ${name} ${T}s infinite both; }`,
		);
		return name;
	};
	const grow = (name, start) => {
		css.push(
			`@keyframes ${name} { 0%, ${pct(start)} { transform: scaleY(0); } ${pct(start + 0.6)}, ${END[0]} { transform: scaleY(1); } ${END[1]}, 100% { transform: scaleY(0); } } .${name} { transform-box: fill-box; transform-origin: bottom; animation: ${name} ${T}s infinite both; }`,
		);
		return name;
	};
	const mark = (name, start) => {
		css.push(
			`@keyframes ${name} { 0%, ${pct(start)} { fill: #fff; } ${pct(start + 0.25)}, ${END[0]} { fill: ${YELLOW}; } ${END[1]}, 100% { fill: #fff; } } .${name} { animation: ${name} ${T}s infinite both; }`,
		);
		return name;
	};
	const W = 1200;
	const H = 640;
	o(`<circle cx="1040" cy="40" r="260" fill="${BLUE}" opacity="0.18" filter="url(#blur)"/>`);
	o(`<circle cx="120" cy="620" r="220" fill="${LIGHT_BLUE}" opacity="0.12" filter="url(#blur)"/>`);
	body.push(...logo(60, 30, 34));
	o(
		`<text x="124" y="56" font-size="26" font-weight="700" fill="#fff" letter-spacing="-0.4">${esc(text.head)}<tspan fill="#9fb3ff" font-weight="500">${esc(text.headRest)}</tspan></text>`,
	);

	const box = {
		x0: 60,
		y0: 92,
		x1: 1140,
		y1: 580,
		split: 735,
		url: "en.wikipedia.org/wiki/List_of_highest-grossing_films",
	};
	window_(body, box);

	// The page: Wikipedia's table, whose 2020s rows the script marks.
	o(
		`<text x="92" y="168" font-size="21" font-weight="600" fill="${INK}" font-family="${SERIF}">Highest-grossing films</text>`,
	);
	o(`<rect x="92" y="180" width="610" height="1" fill="#c8ccd6"/>`);
	const films = [
		[1, "Avengers: Endgame", "$2.94B", 2019],
		[2, "Avatar", "$2.92B", 2009],
		[3, "Spider-Man: Brand New Day", "$2.52B", 2026],
		[4, "Avatar: The Way of Water", "$2.33B", 2022],
		[5, "Titanic", "$2.26B", 1997],
		[6, "Ne Zha 2", "$2.22B", 2025],
		[7, "Star Wars: The Force Awakens", "$2.07B", 2015],
		[8, "Avengers: Infinity War", "$2.05B", 2018],
		[9, "Spider-Man: No Way Home", "$1.92B", 2021],
	];
	const [tx, tw, ty, rh] = [92, 610, 198, 36];
	o(`<rect x="${tx}" y="${ty}" width="${tw}" height="30" fill="#eaecf0" stroke="#c8ccd6"/>`);
	for (const [dx, label] of [
		[14, "Rank"],
		[70, "Title"],
		[400, "Worldwide gross"],
		[540, "Year"],
	]) {
		o(`<text x="${tx + dx}" y="${ty + 20}" font-size="13" font-weight="600" fill="${INK}">${label}</text>`);
	}
	let marked = 4.15;
	films.forEach(([rank, title, gross, year], i) => {
		const y = ty + 30 + i * rh;
		let cls = "";
		if (year >= 2020) {
			cls = ` class="marked ${mark(`row${i}`, marked)}"`;
			marked += 0.22;
		}
		o(`<rect x="${tx}" y="${y}" width="${tw}" height="${rh}" fill="#fff" stroke="#c8ccd6"${cls}/>`);
		o(`<text x="${tx + 14}" y="${y + 23}" font-size="14" fill="${INK}">${rank}</text>`);
		o(`<text x="${tx + 70}" y="${y + 23}" font-size="14" font-style="italic" fill="#3366cc">${esc(title)}</text>`);
		o(`<text x="${tx + 400}" y="${y + 23}" font-size="14" fill="${INK}">${gross}</text>`);
		o(`<text x="${tx + 540}" y="${y + 23}" font-size="14" fill="${INK}">${year}</text>`);
	});

	// The panel.
	const px = box.split + 22;
	const pw = box.x1 - px - 20;
	o(`<g class="${show("ask", 0.4, undefined, 8)}">`);
	const askW = Math.max(...text.ask.map((line) => width(line, 15.5))) + 32;
	o(`<rect x="${px + pw - askW}" y="148" width="${askW}" height="60" rx="14" fill="${BLUE}"/>`);
	text.ask.forEach((line, i) => {
		o(`<text x="${px + pw - askW + 16}" y="${172 + i * 21}" font-size="15.5" fill="#fff">${esc(line)}</text>`);
	});
	o("</g>");
	const step = (y, title, sub, cls) => {
		o(`<g class="${cls}">`);
		o(`<circle cx="${px + 6}" cy="${y}" r="5" fill="none" stroke="#9aa3b5" stroke-width="1.6"/>`);
		o(`<text x="${px + 22}" y="${y + 5}" font-size="14.5" fill="${MUTED}">${esc(title)}</text>`);
		if (sub) o(sub);
		o("</g>");
	};
	o(`<rect x="${px + 5.2}" y="232" width="1.6" height="58" fill="${LINE}" class="${show("rail", 2)}"/>`);
	step(232, text.read, "", show("s1", 1.2, undefined, 6));
	// The card that asks, replaced by the script's step once the user allows it.
	o(`<g class="${show("card", 2, 3.55, 6)}">`);
	o(`<rect x="${px}" y="252" width="${pw}" height="78" rx="10" fill="#fff" stroke="${LINE}"/>`);
	o(`<text x="${px + 14}" y="277" font-size="14.5" font-weight="600" fill="${INK}">${esc(text.card)}</text>`);
	o(
		`<text x="${px + 14}" y="296" font-size="12.5" fill="${MUTED}" font-family="${MONO}">for (const row of table.rows) …</text>`,
	);
	o(`<rect x="${px + 14}" y="303" width="62" height="20" rx="6" fill="${BLUE}"/>`);
	o(
		`<text x="${px + 45}" y="317.5" text-anchor="middle" font-size="13" font-weight="600" fill="#fff">${esc(text.allow)}</text>`,
	);
	o(`<rect x="${px + 82}" y="303" width="56" height="20" rx="6" fill="#fff" stroke="#c8ccd6"/>`);
	o(`<text x="${px + 110}" y="317.5" text-anchor="middle" font-size="13" fill="${INK}">${esc(text.deny)}</text>`);
	o("</g>");
	step(
		290,
		text.ran,
		`<text x="${px + 22}" y="311" font-size="12.5" fill="#8a93a6" font-family="${MONO}">for (const row of table.rows) …</text>`,
		show("s2", 3.7, undefined, 6),
	);
	// The thread from the script's step to the rows it marked.
	o(
		`<path d="M${px - 4} 293 C ${px - 70} 293, ${box.split - 40} 330, ${tx + tw - 6} 330" fill="none" stroke="${BLUE}" stroke-width="2" stroke-dasharray="5 5" class="${show("thread", 3.9)}"/>`,
	);
	o(`<circle cx="${tx + tw - 6}" cy="330" r="4" fill="${BLUE}" class="${show("dot", 3.9)}"/>`);
	// The answer and its chart.
	o(`<g class="${show("answer", 5.4, undefined, 6)}">`);
	text.answer.forEach((parts, i) => {
		const spans = parts
			.map(([part, bold]) => (bold ? `<tspan font-weight="700">${esc(part)}</tspan>` : esc(part)))
			.join("");
		o(`<text x="${px}" y="${350 + i * 22}" font-size="16" fill="${INK}">${spans}</text>`);
	});
	o(`<rect x="${px}" y="388" width="${pw}" height="170" rx="10" fill="#fff" stroke="${LINE}"/>`);
	o(
		`<text x="${px + pw / 2}" y="411" text-anchor="middle" font-size="13.5" font-weight="600" fill="${INK}">${esc(text.chart)}</text>`,
	);
	o("</g>");
	const base = 536;
	const bars = [
		["1990s", 1],
		["2000s", 3],
		["2010s", 32],
		["2020s", 14],
	];
	const [bw, gap] = [52, 28];
	const bx = px + (pw - (4 * bw + 3 * gap)) / 2;
	bars.forEach(([label, n], i) => {
		const h = Math.max(3, (n / 32) * 100);
		const x = bx + i * (bw + gap);
		const color = label === "2020s" ? "#f2c230" : "#5b7bd9";
		o(
			`<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="3" fill="${color}" class="${grow(`bar${i}`, 5.8 + i * 0.15)}"/>`,
		);
		o(`<g class="${show(`label${i}`, 6.4 + i * 0.15)}">`);
		o(
			`<text x="${x + bw / 2}" y="${base - h - 6}" text-anchor="middle" font-size="13.5" font-weight="600" fill="${INK}">${n}</text>`,
		);
		o(
			`<text x="${x + bw / 2}" y="${base + 15}" text-anchor="middle" font-size="12.5" fill="${MUTED}">${label}</text>`,
		);
		o("</g>");
	});
	// The user's pointer, clicking Allow.
	css.push(
		`@keyframes pointer { 0%, ${pct(2.3)} { opacity: 0; transform: translate(150px, 150px); } ${pct(2.5)} { opacity: 1; transform: translate(150px, 150px); } ${pct(3.1)} { opacity: 1; transform: translate(0, 0); } ${pct(3.25)} { opacity: 1; transform: translate(0, 0) scale(0.85); } ${pct(3.4)} { opacity: 1; transform: translate(0, 0); } ${pct(3.9)} { opacity: 0; transform: translate(40px, 30px); } 100% { opacity: 0; } } .pointer { animation: pointer ${T}s infinite both; transform-box: fill-box; }`,
	);
	o(
		`<g class="pointer"><path transform="translate(${px + 45} 314)" d="M0 0 L0 18 L5 13.5 L8.5 21 L11.5 19.6 L8 12.4 L14 12.4 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g>`,
	);
	o(`<text x="${W / 2}" y="616" text-anchor="middle" font-size="13.5" fill="#8f9cc6">${esc(text.footer)}</text>`);
	css.push(
		`@media (prefers-reduced-motion: reduce) { * { animation: none !important; } .card, .pointer { display: none; } .marked { fill: ${YELLOW}; } }`,
	);
	return svg(W, H, text.label, "", css.join("\n"), body);
}

for (const [locale, { file }] of Object.entries(TEXT)) {
	for (const [name, draw] of [
		["overview", overview],
		["agent", agent],
	]) {
		const path = join(out, `${file}${name}.svg`);
		writeFileSync(path, draw(locale));
		console.log(path);
	}
}
