// Screenshots of pi-aside for the README and the store, 1280 x 800: a headline over the production panel beside a live
// page, in a plain browser window. Seven scenes on real sites, in English and, for the store's Chinese listing, in
// Chinese: one script that counts a Wikipedia table by decade and marks rows on the page, which pi charts; a screenshot of an
// error, which pi finds among Vite's issues; a selected paragraph of MDN explained with a flowchart; one script that
// ranks Hacker News's front page by comments and marks the top 5; a chart of Our World in Data read from a screenshot;
// the card that asks before pi acts on GitHub; and the README's saved prompt "Translate in page", which puts a
// translation under each selected paragraph of a Wikipedia article: Chinese for the English image, French for the
// Chinese one, so the translation stands out from the original.
// Chrome's side panel is browser UI that automation cannot capture, so the panel runs as a tab and the two are put side
// by side. The pages are loaded live from their sites, in a fresh profile without a login. The model's turns come from
// pi-ai's in-process faux provider; the page tools and scripts run for real, and the answers take their facts from the
// live pages and the chart's own data while the script runs. Tools are in Ask, the default: the script clicks Allow
// as the user would, except in the last scene, which shows the card. Without LIVE, no account, key, or paid request is
// used.
// The store shows screenshots at about 595 x 372: the headline is large, and the window runs off the bottom, without
// the composer, so the panel can be drawn larger.
// Run: CHROME="/path/to/chrome-for-testing" npm run screenshots   (writes docs/images/)
// SCENES=table,issue takes only those scenes, and LOCALES=en only that language.
// LIVE=1 takes the scenes that a real model runs (a diagram on Excalidraw, a summary of an essay, a JSFiddle app, the
// saved prompt Translate in page, a question about a selection, a JupyterLite notebook, and a GitHub repository's
// issues) with the test browser's own ChatGPT session: the first run prints a sign-in link for the owner's browser,
// and ~/.cache/pi-aside-live keeps the session. RECORD=app also records that scene's run as an animated WebP.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../", import.meta.url));
const out = join(repo, "docs/images");
const dir = mkdtempSync(join(tmpdir(), "pi-screenshots-"));
const ext = join(dir, "ext");
mkdirSync(ext);
mkdirSync(out, { recursive: true });
cpSync(join(repo, "static"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
/** Live: ~/.cache/pi-aside-live keeps the test browser's own ChatGPT session, not the owner's pi-aside's, whose refresh
 * token it would replace. */
const LIVE = process.env.LIVE === "1" ? join(homedir(), ".cache/pi-aside-live") : undefined;
const SESSION = LIVE === undefined ? undefined : join(LIVE, "openai.json");

// The image, in px: the headline above a window inset by INSET, from TOP to below the bottom edge; one row of window
// chrome, then the page and the panel side by side. The panel gets 40% of the window and is drawn at ZOOM.
const WIDTH = 1280;
const HEIGHT = 800;
const TOP = 165;
const INSET = 40;
const CHROME = 44;
const PANEL = 480;
const ZOOM = 1.1;
const VIEW = { width: WIDTH - 2 * INSET - PANEL, height: HEIGHT - TOP - CHROME };
// The panel's composer, usage line, and model bar run off the bottom: the chat ends at the image's edge.
const COMPOSER = 120;
const PANEL_VIEW = { width: Math.round(PANEL / ZOOM), height: Math.round(VIEW.height / ZOOM) + COMPOSER };

const FILMS = "https://en.wikipedia.org/wiki/List_of_highest-grossing_films";
const VITE = "https://github.com/vitejs/vite";
// The error's own issue, and the change that closed it: the answer is checked against both on the live page.
const ISSUE = 9200;
const FIX = 9837;
const MDN = "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching";
const QUOTE = "Stored HTTP responses have two states: fresh and stale.";
const CHART = "https://ourworldindata.org/grapher/share-electricity-renewables";
const COUNTRIES = ["DEU", "CHN", "USA", "IND"];
const ISSUES = "https://github.com/vitejs/vite/issues";
const HN = "https://news.ycombinator.com/";
// The articles' leads, as the translations were written for them: each paragraph found by how it starts, and compared
// whole, without spacing or citation marks, so any edit to them stops the run. Chinese takes more room in English: one
// paragraph and its translation fill the page.
const AURORA = "https://zh.wikipedia.org/zh-cn/%E6%9E%81%E5%85%89";
const AURORA_LEAD = [
	{
		start: "极光，是一种等离子体现象",
		text: "极光，是一种等离子体现象，主要发生在具有磁场的行星上的高纬度区域，而在地球上的极光带即是经度上距离地磁极10°至20°，纬度宽约3°至6°的区域。当磁暴发生时，在较低的纬度也会出现极光。",
	},
];
const AURORE = "https://fr.wikipedia.org/wiki/Aurore_polaire";
const AURORE_LEAD = [
	{
		start: "L’aurore polaire, également appelée",
		text: "L’aurore polaire, également appelée « aurore boréale » dans l'hémisphère nord et « aurore australe » dans l'hémisphère sud, est un phénomène lumineux atmosphérique caractérisé par des voiles extrêmement colorés dans le ciel nocturne, le vert étant prédominant aux latitudes proches des pôles.",
	},
	{
		start: "Provoquées par l'interaction entre les particules",
		text: "Provoquées par l'interaction entre les particules chargées du vent solaire et la haute atmosphère, les aurores se produisent principalement dans les régions proches des pôles magnétiques, dans une zone annulaire justement appelée « zone aurorale » (entre 65 et 75° de latitude).",
	},
];
// Access to all sites, as after Settings > Advanced > Sites > Allow all sites: Chrome lets pi capture a tab with it, or after a
// click on pi's toolbar button, which automation cannot make.
manifest.host_permissions = ["<all_urls>"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// --- Table: the highest-grossing films by decade, and the 2020s marked on the page -----------------------------------

// Plain lines first: the step shows the script's start on a few lines.
const tableCode = `const table = document.querySelector(
  "table.wikitable.sortable");
const head = [...table.rows[0].cells]
  .map((cell) => cell.textContent.trim());
const year = head.indexOf("Year");
const decades = {};
let total = 0, recent = 0;
for (const row of table.rows) {
  const y = parseInt(
    row.cells[year]?.textContent);
  // The header row has no year.
  if (!(y > 1900)) continue;
  total++;
  const decade = y - (y % 10);
  decades[decade] = (decades[decade] ?? 0) + 1;
  if (decade !== 2020) continue;
  recent++;
  for (const cell of row.cells)
    cell.style.background = "#ffe08a";
}
return { total, recent, decades };`;

// --- Hacker News: the front page ranked by comments, the top 5 marked on the page --------------------------------------

const rankCode = `const stories = [];
for (const row of document
  .querySelectorAll("tr.athing")) {
  const sub = row.nextElementSibling;
  const score = sub.querySelector(".score");
  // Job ads have no points or comments.
  if (!score) continue;
  // The story's own link that gives the count:
  // "12 comments", or "discuss" when none yet.
  const count = [...sub.querySelectorAll(
    \`a[href="item?id=\${row.id}"]\`)]
    .map((a) => a.textContent
      .replace(/\\s+/g, " ").trim())
    .find((text) =>
      /^(\\d+ comments?|discuss)$/.test(text));
  if (count === undefined)
    throw Error("No comment count: " + row.id);
  stories.push({
    row,
    id: row.id,
    title: row.querySelector(".titleline > a")
      .textContent,
    points: parseInt(score.textContent),
    comments: count === "discuss" ? 0
      : parseInt(count),
  });
}
stories.sort((a, b) => b.comments - a.comments);
const top = stories.slice(0, 5);
for (const { row } of top)
  row.style.background = "#ffe08a";
return {
  stories: stories.length,
  top: top.map(({ row, ...story }) => story),
};`;

// --- What the user types and what the scripted model does ------------------------------------------------------------

const read = (args = {}) => ({ tool: "read_page", args });
const observe = (find, pause) => ({ tool: "observe_page", args: { find }, pause });
const act = (summary, args, label) => ({ tool: "act_on_page", args: { ...args, summary }, label });
const go = (summary, url, pause) => ({ tool: "act_on_page", args: { action: "navigate", url, summary }, pause });
/** A bar chart of `decades` (the script's counts), one bar per decade, empty ones too; low, with each bar's number. */
const decadeChart = (decades, { title, axis }) => {
	const years = Object.keys(decades).map(Number);
	const bars = [];
	for (let year = Math.min(...years); year <= Math.max(...years); year += 10)
		bars.push([`${year}s`, decades[year] ?? 0]);
	return [
		"```mermaid",
		"---",
		"config:",
		"  xyChart:",
		"    height: 220",
		"    showDataLabel: true",
		"---",
		"xychart-beta",
		`  title "${title}"`,
		`  x-axis [${bars.map(([label]) => `"${label}"`).join(", ")}]`,
		`  y-axis "${axis}"`,
		`  bar [${bars.map(([, count]) => count).join(", ")}]`,
		"```",
	].join("\n");
};
/** The decade with the most films, from the script's counts. */
const topDecade = (decades) => Object.entries(decades).reduce((top, each) => (each[1] > top[1] ? each : top));
// Each headline: [before, the words in the accent colour, after], and its subline.
const TEXT = {
	en: {
		heads: {
			table: [["From a table ", "to a chart", ""], "Counts the whole table and highlights matching rows."],
			issue: [["Show pi ", "the error", ""], "Attach an error screenshot. pi searches and reads matching issues."],
			explain: [["Ask about ", "what you read", ""], "Clear answers, with a table or a diagram when it helps."],
			rank: [["One script, ", "the whole page", ""], "It reads every story, ranks them, and marks the top 5."],
			chart: [["Read ", "charts", ", too"], "When the answer is in a picture, pi takes a screenshot."],
			control: [["You decide ", "when it acts", ""], "pi clicks or types on a site only after you allow it."],
			diagram: [["Draw on ", "a whiteboard", ""], "Ask for a diagram, and pi draws it right on Excalidraw."],
			notebook: [["Analyze data in ", "a notebook", ""], "pi writes the code, runs it, and reads the chart."],
			summary: [["Summarize ", "any page", ""], "The key points in seconds, then ask a follow-up."],
			app: [["Build ", "a working app", ""], "pi writes the HTML, CSS, and JavaScript, and it runs right away."],
			issues: [
				["Dig into ", "a whole repo", ""],
				"One script reads 100 issues, charts them, and marks the hottest.",
			],
			translate: [
				["Translate ", "in place", ""],
				"A saved prompt: each translation goes right under its paragraph.",
			],
		},
		notebook: {
			ask: "In a new Python notebook, load the Titanic passengers from https://raw.githubusercontent.com/mwaskom/seaborn-data/master/titanic.csv, plot the survival rate by class and sex, and tell me what stands out.",
		},
		summary: { ask: "Summarize this page in 5 key points." },
		app: {
			ask: "Build a Pomodoro timer here: start, pause, and reset, a progress ring, and a calm color theme. Then run it, and show the result large.",
		},
		issues: {
			ask: "Which areas do the 100 newest open issues fall in? Chart them, and highlight the 5 most-discussed issues on this page.",
		},
		diagram: {
			ask: "Draw a simple, colorful diagram of how a web request reaches the server: browser, CDN, load balancer, app server, cache, and database. Make it big and easy to read.",
		},
		table: {
			ask: "When did these come out? Chart them by decade, and highlight the ones from the 2020s.",
			summary: "Count the films by decade; mark the 2020s",
			chart: { title: "Films per decade", axis: "Films" },
			answer: ({ total, recent, decades }) => {
				const [decade, count] = topDecade(decades);
				return `**${count} of ${total}** came out in the ${decade}s. The **${recent}** from the 2020s are highlighted on the page.`;
			},
		},
		issue: {
			ask: "I get this since upgrading to Vite 3. Is it a known issue? How do I fix it?",
			search: "Search the issues for the error",
			open: `Open #${ISSUE}, the closest match`,
			answer: `**#${ISSUE}**, a Vite 3 regression: **postcss**, via **sanitize-html**, reads Node's \`path\`. **#${FIX}** made it a warning, so updating fixes this case; \`path\` still won't work in the browser.`,
		},
		explain: {
			ask: "Explain this simply, with a diagram.",
			answer: [
				"**Fresh** until older than `max-age`; then **stale**:",
				"```mermaid\nflowchart TD\n  A{{Still fresh?}} -->|Yes| B[Use it, no request]\n  A -->|No, stale| C[Ask the server]\n  C -->|304 Not Modified| D[Reuse it]\n  C -->|200 OK| E[Use the new copy]\n  classDef fresh fill:#dcf3e4,stroke:#2f9e5b,color:#14361f\n  classDef stale fill:#fdebd3,stroke:#d9822b,color:#4a2a05\n  classDef fetched fill:#e1e9fd,stroke:#3158d8,color:#14224d\n  class B,D fresh\n  class C stale\n  class E fetched\n```",
			].join("\n\n"),
		},
		rank: {
			ask: "Which 5 stories on this page have the most comments? Highlight them.",
			summary: "Rank the stories by comments; mark the top 5",
			head: "| Story | Points | Comments |\n| --- | --: | --: |",
			answer: (stories) => `The most discussed of **${stories}**, marked on the page:`,
		},
		chart: {
			ask: "Which of these raised its share of renewables the most since 2010?",
			names: { DEU: "Germany", CHN: "China", USA: "The US", IND: "India" },
			answer: (top, from, to) =>
				`**${top.name}**, by far: from about ${top.from}% in ${from} to about ${top.to}% in ${to}, as the chart shows. The others:`,
		},
		control: {
			ask: "Show only the open bugs, and tell me which is the oldest.",
			labels: ["labels", "Filter by labels"],
			summary: "Open the label filter",
		},
		// The README's prompt, as the user adds it.
		translate: {
			name: "Translate in page",
			template:
				"Translate the text below into {{language}}, then embed the translation back into the original page, paragraph by paragraph: each translated paragraph right below its original. Keep the original text.\n\nStyle each translation as a plain paragraph in the page's own typography: no border, vertical line, quote formatting, background color, or other decoration.\n\n{{selection}}",
			summary: "Put each translation under its paragraph",
			url: AURORA,
			lead: AURORA_LEAD,
			// Above the paragraph: the article's tab bar shows whole, and the contents button that floats at the top
			// left stays clear of the first word.
			above: 70,
			lines: [
				"An aurora is a plasma phenomenon that occurs mainly at high latitudes on planets with a magnetic field. On Earth, the auroral zone lies 10° to 20° from the geomagnetic poles and is about 3° to 6° of latitude wide. During magnetic storms, auroras also appear at lower latitudes.",
			],
			answer: "Done: the paragraph is translated into English, right under its original.",
		},
	},
	zh_CN: {
		heads: {
			table: [["从表格", "到图表", ""], "读完整张表，按年代统计，并标出符合条件的行。"],
			issue: [["把报错", "截图", "交给 pi"], "拖入报错截图，pi 搜索相关 issue，核对修复说明。"],
			explain: [["读到哪，", "问到哪", ""], "回答清楚，需要时配上表格或图。"],
			rank: [["一段脚本，", "读完整页", ""], "读取每条新闻，排好顺序，并在页面上标出前 5 条。"],
			chart: [["", "图表", "也能读"], "答案在图里时，pi 会截图细看。"],
			control: [["动手之前，", "先问你", ""], "pi 在网站上点击或输入之前，先征得你的同意。"],
			diagram: [["在白板上", "画图", ""], "让 pi 画一张架构图，它直接画在 Excalidraw 上。"],
			notebook: [["在笔记本里", "分析数据", ""], "pi 写代码、运行，再解读图表。"],
			summary: [["一键", "总结全文", ""], "几秒读懂要点，还能接着追问。"],
			app: [["做出", "能用的小应用", ""], "pi 写好 HTML、CSS 和 JavaScript，马上就能运行。"],
			issues: [["一眼看懂", "整个仓库", ""], "一段脚本读完 100 个 issue，画成图，再标出最热的几个。"],
			translate: [["", "页面内", "翻译"], "常用提示词：每段译文紧跟在对应原文的下方。"],
		},
		notebook: {
			ask: "新建一个 Python 笔记本，载入泰坦尼克号乘客数据 https://raw.githubusercontent.com/mwaskom/seaborn-data/master/titanic.csv ，按舱位等级和性别画出生还率，再告诉我有什么值得注意的。",
		},
		summary: { ask: "用 5 个要点总结这个页面。" },
		app: { ask: "在这里做一个番茄钟：开始、暂停、重置，带进度圆环和柔和的配色，然后运行它，并把结果放大显示。" },
		issues: { ask: "最新的 100 个未关闭 issue 分属哪些领域？画个图，并在这个页面上标出讨论最多的 5 个。" },
		diagram: {
			ask: "画一张简洁、彩色的图，说明网页请求是怎么到达服务器的：浏览器、CDN、负载均衡、应用服务器、缓存和数据库。画大一点，方便看清。",
		},
		table: {
			ask: "这些电影是哪年上映的？按年代画张图，并把 2020 年代的标出来。",
			summary: "按年代统计，标出 2020 年代的电影",
			chart: { title: "各年代上映部数", axis: "部数" },
			answer: ({ total, recent, decades }) => {
				const [decade, count] = topDecade(decades);
				return `**${total} 部里有 ${count} 部**是 ${decade} 年代上映的。页面上标出了 2020 年代的 **${recent}** 部。`;
			},
		},
		issue: {
			ask: "升级到 Vite 3 后出现这个报错。是已知问题吗？怎么解决？",
			search: "在 issue 里搜索这个报错",
			open: `打开最接近的 #${ISSUE}`,
			answer: `**#${ISSUE}**，Vite 3 的回归问题：**sanitize-html** 引入的 **postcss** 读取了 Node 的 \`path\`。**#${FIX}** 把报错改成了警告，升级即可解决；但浏览器里仍不能用 \`path\`。`,
		},
		explain: {
			ask: "用中文简单解释这段话，并画一张图。",
			answer: [
				"超过 `max-age` 前是**新鲜**的，之后就**过期**了：",
				"```mermaid\nflowchart TD\n  A{{还新鲜吗？}} -->|是| B[直接用，不发请求]\n  A -->|否，已过期| C[问服务器]\n  C -->|304 Not Modified| D[继续用旧副本]\n  C -->|200 OK| E[换用新副本]\n  classDef fresh fill:#dcf3e4,stroke:#2f9e5b,color:#14361f\n  classDef stale fill:#fdebd3,stroke:#d9822b,color:#4a2a05\n  classDef fetched fill:#e1e9fd,stroke:#3158d8,color:#14224d\n  class B,D fresh\n  class C stale\n  class E fetched\n```",
			].join("\n\n"),
		},
		rank: {
			ask: "这一页里评论最多的 5 条新闻是哪些？在页面上标出来。",
			summary: "按评论数给新闻排序，标出前 5 条",
			head: "| 新闻 | 点数 | 评论 |\n| --- | --: | --: |",
			answer: (stories) => `**${stories}** 条里讨论最多的 5 条，已在页面上标出：`,
		},
		chart: {
			ask: "2010 年以来，这几个国家里谁的可再生能源占比涨得最多？",
			names: { DEU: "德国", CHN: "中国", USA: "美国", IND: "印度" },
			answer: (top, from, to) =>
				`**${top.name}**，遥遥领先：从 ${from} 年的约 ${top.from}% 涨到 ${to} 年的约 ${top.to}%。其他几个：`,
		},
		control: {
			ask: "只看还没关闭的 bug，告诉我最早的是哪一个。",
			labels: ["labels", "Filter by labels"],
			summary: "打开标签筛选",
		},
		translate: {
			name: "页面内翻译",
			template:
				"把下面的内容译成中文，再逐段放回原网页：每段译文紧跟在对应的原文段落下方，保留原文。\n\n译文使用网页正文的普通段落样式，不要加左边框、竖线、引用样式、背景色或其他装饰。\n\n{{selection}}",
			summary: "把每段译文放到原文下方",
			url: AURORE,
			lead: AURORE_LEAD,
			// Above the paragraph: the contents button that floats at the top left stays clear of its first word.
			above: 64,
			lines: [
				"极光在北半球称为“北极光”，在南半球称为“南极光”，是一种大气发光现象：夜空中出现色彩极为艳丽的光幕，在靠近两极的纬度上以绿色为主。",
				"极光由太阳风中的带电粒子与高层大气相互作用产生，主要出现在磁极附近，分布在一个环形地带里，这个地带也因此被称为“极光带”（纬度 65° 至 75° 之间）。",
			],
			answer: "完成：两段都已译成中文，每段译文紧跟在原文下方。",
		},
	},
};

const entry = join(dir, "entry.mjs");
const liveEntry = `
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { PRESETS } from ${JSON.stringify(join(repo, "src/shared/presets.ts"))};
globalThis.__piShots = { saveSettings, PRESETS };
`;
writeFileSync(
	entry,
	LIVE !== undefined
		? liveEntry
		: `
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { PRESETS } from ${JSON.stringify(join(repo, "src/shared/presets.ts"))};
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider({
	provider: "openrouter",
	models: [{ id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", contextWindow: 200000,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }],
	tokensPerSecond: 400,
});
models.setProvider(faux.provider);
globalThis.fetch = async () => { throw Error("Unexpected network request while taking screenshots"); };
/** The ref on the last observe_page outline's line for the element whose name starts with \`label\`. */
const refOf = (context, label) => {
	const seen = context.messages.filter((message) => message.role === "toolResult" && message.toolName === "observe_page").at(-1);
	const outline = JSON.parse(seen.content[0].text).outline;
	const line = outline.split("\\n").find((each) => each.includes(\`"\${label}\`));
	if (line === undefined) throw Error(\`No "\${label}" in:\\n\${outline}\`);
	return [...line.matchAll(/\\b([a-z]+\\d+)\\b/g)].at(-1)[1];
};
const message = (text, tool, args) =>
	fauxAssistantMessage([...(text ? [fauxText(text)] : []), ...(tool ? [fauxToolCall(tool, args)] : [])],
		tool ? { stopReason: "toolUse" } : {});
/**
 * A turn: text, a tool call, or both. \`label\` takes the call's ref from the last outline; \`later\` waits for the
 * text, which the script gives when it has read the page or the last tool result (the chat so far is kept for it);
 * \`pause\` is the model's time to answer, in ms, for a page that is still loading.
 */
const turn = ({ text, tool, args, label, later, pause = 0 }) => {
	if (later)
		return (context) =>
			new Promise((resolve) => {
				globalThis.__piShots.context = context;
				globalThis.__piShots.release = (text) => resolve(message(text));
			});
	return async (context) => {
		await new Promise((resolve) => setTimeout(resolve, pause));
		return message(text, tool, label === undefined ? args : { ...args, ref: refOf(context, label) });
	};
};
globalThis.__piShots = { saveSettings, PRESETS, release: null, context: null, play: (turns) => faux.setResponses(turns.map(turn)) };
`,
);
const common = {
	absWorkingDir: repo,
	nodePaths: [join(repo, "node_modules")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome140",
	logLevel: "warning",
};
await build({
	...common,
	entryPoints: [entry],
	outfile: join(ext, "background.js"),
	plugins: [
		{
			name: "screenshot-main-hooks",
			setup(builder) {
				builder.onLoad({ filter: /\/background\/main\.ts$/ }, ({ path }) => ({
					contents: `${readFileSync(path, "utf8")}\nglobalThis.__piShotsMain = { begin, askSelection };`,
					loader: "ts",
					resolveDir: join(repo, "src/background"),
				}));
			},
		},
	],
});
await build({
	...common,
	entryPoints: {
		panel: "src/panel/panel.ts",
		"diagram-worker": "src/panel/diagram-worker.ts",
		"chatgpt-callback": "src/callback/chatgpt-callback.ts",
	},
	outdir: ext,
});

async function poll(test, name, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await test();
		if (value) return value;
		await sleep(100);
	}
	throw Error(`Timed out: ${name}`);
}

/**
 * Puts a headline over a page and its panel in a plain browser window, and writes it to docs/images. `head`: the
 * headline's three parts, the middle one in the accent colour, and the subline. The chat is shown from its question, so
 * the image has the question and the answer together.
 */
/**
 * Records a live run for the README, page and panel side by side, as an animated WebP: a frame every 2 s, a frame
 * that shows nothing new left out, so waits for the model take no time; the finished page is held at the end.
 */
function record({ page, panel }, file) {
	const frames = join(dir, `frames-${file}`);
	mkdirSync(frames);
	let stopped = false;
	let failure;
	let last = "";
	let count = 0;
	const frame = async () => {
		const [left, right] = [await page.screenshot(), await panel.screenshot()];
		const key = createHash("sha1").update(left).update(right).digest("hex");
		if (key === last) return;
		last = key;
		writeFileSync(join(frames, "page.png"), left);
		writeFileSync(join(frames, "panel.png"), right);
		// The page at 2x is VIEW.height * 2 tall; the panel, zoomed, is drawn to the same height.
		execFileSync("ffmpeg", [
			...["-loglevel", "error", "-i", join(frames, "page.png"), "-i", join(frames, "panel.png")],
			...["-filter_complex", `[1]scale=-1:${VIEW.height * 2}[p];[0][p]hstack,scale=1280:-1`],
			join(frames, `${String(count++).padStart(4, "0")}.png`),
		]);
	};
	// A failed frame ends the recording; encode reports it, so a broken run is never written as an animation.
	const done = (async () => {
		while (!stopped) {
			await frame();
			await sleep(2000);
		}
	})().catch((error) => {
		failure = error;
	});
	const stop = async () => {
		stopped = true;
		await done;
	};
	return {
		stop,
		/** Adds the finished page as the last frame and writes the animation. */
		async encode() {
			await stop();
			if (failure) throw failure;
			await frame();
			const list = readdirSync(frames)
				.filter((name) => /^\d{4}\.png$/.test(name))
				.sort();
			const args = list.flatMap((name, i) => ["-d", i === list.length - 1 ? "4000" : "150", join(frames, name)]);
			execFileSync("img2webp", ["-loop", "0", "-lossy", "-q", "70", ...args, "-o", join(out, `${file}.webp`)]);
			console.log(join(out, `${file}.webp`));
		},
	};
}

async function save(page, panel, { head: [[before, accent, after], subline], file, end = false }) {
	await page.bringToFront();
	// A tab brought to the front shows its old frame, or none, until Chrome paints it again.
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	await sleep(1000);
	const pageShot = await page.screenshot();
	await panel.bringToFront();
	// By the wheel, as the user would: the chat follows its end until the user scrolls.
	await panel.mouse.move(PANEL_VIEW.width / 2, 200);
	await panel.mouse.wheel(0, end ? 10_000 : -10_000);
	await panel.mouse.move(0, 0);
	await sleep(500);
	const chat = await panel.evaluate(() => {
		const box = [...document.querySelectorAll("*")].find(
			(each) => getComputedStyle(each).overflowY === "auto" && each.querySelector(".msg"),
		);
		return { below: box.scrollHeight - box.clientHeight, bottom: box.getBoundingClientRect().bottom };
	});
	if (chat.below > 0 && !end)
		console.log(`${file}: the chat goes on ${chat.below} px below the panel; check that the answer shows.`);
	const panelShot = await panel.screenshot({ clip: { x: 0, y: 0, width: PANEL_VIEW.width, height: chat.bottom } });

	const image = (png) => `data:image/png;base64,${png.toString("base64")}`;
	const icon = image(readFileSync(join(repo, "static/icons/icon-32.png")));
	const frame = `<!doctype html><style>
*{box-sizing:border-box}
body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;font:13px system-ui,"PingFang SC",sans-serif;
background:radial-gradient(900px 500px at 100% 0%,#d9e3ff 0%,transparent 60%),linear-gradient(180deg,#f5f7fc,#e9eef9)}
h1{position:absolute;left:64px;top:34px;margin:0;font:800 56px/1.1 system-ui,"PingFang SC",sans-serif;letter-spacing:-.025em;color:#0e1430}
h1 em{font-style:normal;color:#3158d8}
p{position:absolute;left:66px;top:108px;margin:0;font-size:23px;color:#4a5578}
.window{position:absolute;left:${INSET}px;right:${INSET}px;top:${TOP}px;height:${HEIGHT - TOP + 20}px;background:#fff;border-radius:14px 14px 0 0;overflow:hidden;box-shadow:0 18px 50px #1b255033,0 2px 6px #1b25501a}
.chrome{height:${CHROME}px;background:#e8ebf2;display:flex;align-items:center;gap:8px;padding:0 14px}
.dots{display:flex;gap:7px;margin-right:8px}.dots i{width:12px;height:12px;border-radius:50%;display:block}
.tab{background:#fff;border-radius:8px;padding:6px 12px;max-width:260px;color:#3c4043;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.url{margin-left:auto;background:#fff;border-radius:14px;padding:5px 14px;color:#5f6368;max-width:520px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chrome img{width:18px;height:18px;margin-left:4px}
.body{display:flex;align-items:flex-start}.body img{display:block}
.side{border-left:1px solid #dadce0;align-self:stretch}
</style>
<h1>${esc(before)}<em>${esc(accent)}</em>${esc(after)}</h1><p>${esc(subline)}</p>
<div class="window"><div class="chrome"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
<div class="tab">${esc(await page.title())}</div><div class="url">${esc(decodeURI(page.url()).replace("https://", ""))}</div><img src="${icon}" alt=""></div>
<div class="body"><img src="${image(pageShot)}" width="${VIEW.width}"><div class="side"><img src="${image(panelShot)}" width="${PANEL - 1}"></div></div></div>`;
	// The 2x captures are scaled down into the 1280 x 800 image.
	const shot = await chromium.launch({ executablePath: process.env.CHROME });
	try {
		const flat = await shot.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
		await flat.setContent(frame);
		await flat.waitForLoadState("load");
		await flat.screenshot({ path: join(out, file) });
	} finally {
		await shot.close();
	}
	console.log(join(out, file));
}

/**
 * Starts Chrome with the extension in `extension`, signed in with a fake key, Act on page and Run script in Ask, and
 * Chrome's Allow User Scripts on for it; gives its worker and id.
 */
async function launch(extension, profile, lang) {
	if (LIVE !== undefined) return launchLive(extension, profile, lang);
	const context = await chromium.launchPersistentContext(join(dir, profile), {
		executablePath: process.env.CHROME,
		headless: false,
		deviceScaleFactor: 2,
		colorScheme: "light",
		locale: lang,
		args: [
			"--headless=new",
			`--lang=${lang}`,
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
		],
		env: { ...process.env, LANGUAGE: lang.replace("-", "_") },
	});
	return started(context);
}

/** Live: the test browser's own ChatGPT session, from SESSION, signed in once by `signIn()`. */
async function launchLive(extension, profile, lang) {
	const context = await chromium.launchPersistentContext(join(dir, profile), {
		executablePath: process.env.CHROME,
		headless: false,
		deviceScaleFactor: 2,
		colorScheme: "light",
		locale: lang,
		args: [
			"--headless=new",
			`--lang=${lang}`,
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
		],
		env: { ...process.env, LANGUAGE: lang.replace("-", "_") },
	});
	const live = await started(context);
	if (!existsSync(SESSION)) await signIn(live);
	const openai = JSON.parse(readFileSync(SESSION, "utf8"));
	await live.worker.evaluate((openai) => chrome.storage.local.set({ credentials: { openai } }), openai);
	return live;
}

/**
 * Signs the test browser in, once. OpenAI's bot check refuses Chrome for Testing, so the owner opens the sign-in link in
 * their own browser; its redirect to the loopback port reaches this script, which hands it to the test browser.
 */
async function signIn({ context, worker, id }) {
	const panel = await context.newPage();
	await panel.goto(`chrome-extension://${id}/panel.html`);
	const opened = context.waitForEvent("page");
	await panel.locator("#setup-chatgpt").click();
	const auth = await opened;
	const link = await poll(() => auth.url().startsWith("https://auth.openai.com/") && auth.url(), "the sign-in link");
	await auth.close();
	const query = new Promise((resolve) => {
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1:1455");
			if (url.pathname !== "/auth/callback") return void response.writeHead(404).end();
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			response.end("The test browser is signing in; you can close this tab.");
			server.close();
			resolve(url.search);
		});
		server.listen(1455, "127.0.0.1");
	});
	console.log(
		`Open this link in your own Chrome within 10 minutes, signed in to ChatGPT, and allow pi-aside:\n${link}`,
	);
	const callback = await context.newPage();
	// Where the worker's rule sends OpenAI's redirect, query kept; the rule redirects only for OpenAI's page.
	await callback.goto(`chrome-extension://${id}/chatgpt-callback.html${await query}`);
	await poll(
		() =>
			worker.evaluate(
				async () => (await chrome.storage.local.get("credentials")).credentials?.openai?.type === "oauth",
			),
		"the sign-in",
	).catch(async (error) => {
		console.log(`The callback page, ${callback.url()}: ${await callback.locator("body").textContent()}`);
		throw error;
	});
	await keepSession({ worker });
	await callback.close();
	await panel.close();
	console.log("Signed in.");
}

/** Saves the session as a run left it: OpenAI replaces the refresh token at each refresh. */
async function keepSession({ worker }) {
	const { credentials } = await worker.evaluate(() => chrome.storage.local.get("credentials"));
	mkdirSync(LIVE, { recursive: true });
	if (credentials?.openai?.type === "oauth")
		writeFileSync(SESSION, JSON.stringify(credentials.openai), { mode: 0o600 });
}

/** Sets up a started Chrome: the settings, and Allow User Scripts on; gives its worker and the extension's id. */
async function started(context) {
	contexts.push(context);
	const worker = await poll(() => context.serviceWorkers().find((w) => w.url().endsWith("/background.js")), "worker");
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piShots)).catch(() => false), "hooks");
	const tools = { read: "on", observe: "on", act: "ask", script: "ask", screenshot: "on" };
	if (LIVE === undefined)
		await worker.evaluate(async (tools) => {
			await chrome.storage.local.set({ credentials: { openrouter: { type: "api_key", key: "not-a-real-key" } } });
			await globalThis.__piShots.saveSettings({
				model: { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
				tools,
			});
		}, tools);
	else
		await worker.evaluate(
			(tools) =>
				globalThis.__piShots.saveSettings({
					model: { provider: "openai", modelId: "gpt-6.1-sol" },
					thinking: "high",
					tools,
				}),
			tools,
		);
	const id = new URL(worker.url()).host;
	// The user turns on Allow User Scripts on pi's details page.
	const details = await context.newPage();
	await details.goto(`chrome://extensions/?id=${id}`);
	const allow = details.locator("#allow-user-scripts");
	if (!(await allow.evaluate((toggle) => toggle.checked))) await allow.click();
	await poll(
		() =>
			worker.evaluate(() => {
				try {
					chrome.userScripts.getScripts().catch(() => {});
					return true;
				} catch {
					return false;
				}
			}),
		"Allow User Scripts on",
	);
	await details.close();
	return { context, worker, id };
}

/** Opens `url` in a tab, starts pi on it as the toolbar button does, and opens its panel beside it. */
async function open({ context, worker, id }, url, prepare) {
	const page = await context.newPage();
	await page.setViewportSize(VIEW);
	await page.goto(url, { waitUntil: "load" });
	await sleep(1500);
	if (prepare) await prepare(page);
	const tabId = await tabOf(worker, page.url());
	await worker.evaluate(async (tabId) => {
		const tab = await chrome.tabs.get(tabId);
		const started = globalThis.__piShotsMain.begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
		await Promise.all([started.captured, started.resolved]);
	}, tabId);
	// Live, the panel has a window of its own, as beside the page: pi captures only the tab in front, and a recording
	// captures both without switching tabs.
	const panel =
		LIVE === undefined
			? await context.newPage()
			: (
					await Promise.all([
						context.waitForEvent("page"),
						worker.evaluate(() => chrome.windows.create({ url: "about:blank", focused: false })),
					])
				)[0];
	await panel.setViewportSize(PANEL_VIEW);
	await panel.goto(`chrome-extension://${id}/panel.html?tab=${tabId}`);
	await panel.locator("#composer").waitFor({ state: "visible" });
	return { page, panel, tabId };
}
const tabOf = (worker, url) =>
	worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url).id, url);

/**
 * Sends `text` from the panel, answering each card with its first button while `answer` holds, until `done` holds.
 * `later`: gives the text of a turn that waits for it, once pi has asked for that turn. `start`: sends the input
 * another way, such as from a menu, in place of `text`.
 */
async function send(chrome, panel, text, done, name, { answer = () => true, later, start, ms = 120_000 } = {}) {
	if (start) await start();
	else {
		await panel.locator("#composer").fill(text);
		await panel.locator("#send").click();
	}
	let released = later === undefined;
	await poll(
		async () => {
			const card = panel.locator(".ask button.primary");
			if ((await card.count()) === 1 && (await card.isEnabled()) && answer()) await card.click();
			if (!released && (await chrome.worker.evaluate(() => typeof globalThis.__piShots.release === "function"))) {
				const text = await later();
				await chrome.worker.evaluate((text) => {
					const release = globalThis.__piShots.release;
					globalThis.__piShots.release = null;
					release(text);
				}, text);
				released = true;
			}
			return done();
		},
		name,
		ms,
	);
	await panel.mouse.move(0, 0);
	await sleep(500);
}
/** What the last tool call returned, as JSON, from the chat that the waiting turn was given. */
const lastResult = (chrome) =>
	chrome.worker.evaluate(() => {
		const results = globalThis.__piShots.context.messages.filter((message) => message.role === "toolResult");
		return JSON.parse(results.at(-1).content[0].text);
	});
const finished = (panel, selector) => async () =>
	(await panel.locator(".msg.live").count()) === 0 && (await panel.locator(selector).count()) > 0;

/**
 * A screenshot of the error the user sees in the browser's console, as a PNG: the message and the first frames of its
 * stack, as Vite 3.0 gives it for sanitize-html, which imports postcss.
 */
async function errorImage() {
	const lines = [
		"at node_modules/postcss/lib/map-generator.js (map-generator.js:4:7)",
		"at node_modules/sanitize-html/index.js (index.js:7:20)",
	];
	const html = `<!doctype html><style>
body{margin:0;width:720px;font:12px/1.5 Menlo,monospace;background:#fff}
.bar{padding:6px 12px;border-bottom:1px solid #e0e0e0;color:#5f6368;font:12px system-ui,sans-serif}
.error{background:#fef0f0;border-bottom:1px solid #f9d6d6;color:#c5221f;padding:8px 12px 10px 34px;position:relative}
.error:before{content:"\\2715";position:absolute;left:12px;top:8px;width:14px;height:14px;border-radius:50%;
background:#d93025;color:#fff;font:9px/14px system-ui;text-align:center}
.stack{padding-left:24px;color:#c5221f}
</style><div class="bar">Console</div><div class="error">Uncaught Error: Module "path" has been externalized for browser
compatibility. Cannot access "path.dirname" in client code.<div class="stack">${lines.map(esc).join("<br>")}</div></div>`;
	const browser = await chromium.launch({ executablePath: process.env.CHROME });
	try {
		const page = await browser.newPage({ viewport: { width: 720, height: 200 }, deviceScaleFactor: 1 });
		await page.setContent(html);
		return await page.locator("body").screenshot();
	} finally {
		await browser.close();
	}
}

/** The chart's share of renewables for each of COUNTRIES, in 2010 and its latest year, from the chart's own data. */
async function renewables() {
	const csv = await (await fetch(`${CHART}.csv?v=1&csvType=full&useColumnShortNames=false`)).text();
	const rows = csv
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => line.split(","))
		.filter(([, code]) => COUNTRIES.includes(code));
	const to = Math.max(...rows.map(([, , year]) => Number(year)));
	const share = (code, year) => {
		const row = rows.find(([, each, at]) => each === code && Number(at) === year);
		if (row === undefined) throw Error(`No ${code} ${year} in ${CHART}`);
		return Math.round(Number(row[3]));
	};
	const shares = COUNTRIES.map((code) => ({ code, from: share(code, 2010), to: share(code, to) }));
	return { from: 2010, to, shares: shares.sort((a, b) => b.to - b.from - (a.to - a.from)) };
}

const SCENES = process.env.SCENES?.split(",");
let hnOpened = 0;
/** The scenes that need a real model: only these run with LIVE=1, and only with it. */
const LIVE_SCENES = ["diagram", "summary", "app", "translate", "explain", "notebook", "issues"];
const scene = (name) =>
	(LIVE !== undefined) === LIVE_SCENES.includes(name) && (SCENES === undefined || SCENES.includes(name));

/** The shots in `locale`'s interface, written as `<prefix><scene>.png`. */
async function shots(locale, lang, prefix) {
	const text = TEXT[locale];
	const chrome = await launch(localized(locale), `profile-${locale}`, lang);
	const play = (turns) => chrome.worker.evaluate((turns) => globalThis.__piShots.play(turns), turns);
	try {
		await scenes(chrome, play, text, prefix);
	} finally {
		// A session that OpenAI rotated during a failed scene is kept too.
		if (LIVE !== undefined) await keepSession(chrome);
	}
}

/** The scenes of one language, in `chrome`. */
async function scenes(chrome, play, text, prefix) {
	/**
	 * A live scene: the owner's ChatGPT session asks on `url`, the tools as the model chooses, and its cards are allowed
	 * as the user would. The run is long: the image shows its end, and the headline says what was asked. `prepare`
	 * readies the page before the ask; `show` readies the finished page for its picture (by default, it undoes a
	 * sideways scroll that pi's steps can leave).
	 */
	const live = async (name, url, { prepare, show = () => window.scrollTo(0, window.scrollY) } = {}) => {
		if (!scene(name)) return;
		let recording;
		// One scene that fails, as a live run can, leaves the others to run.
		try {
			const view = await open(chrome, url, prepare);
			if (process.env.RECORD === name) recording = record(view, `${prefix}${name}`);
			await send(chrome, view.panel, text[name].ask, finished(view.panel, ".msg.assistant:not(.step-note)"), name, {
				ms: 15 * 60_000,
			});
			await view.page.evaluate(show);
			await save(view.page, view.panel, { head: text.heads[name], file: `${prefix}${name}.png`, end: true });
			await recording?.encode();
		} catch (error) {
			console.log(`${prefix}${name}.png: ${error.message}`);
		} finally {
			await recording?.stop();
			await keepSession(chrome);
		}
	};
	await live("diagram", "https://excalidraw.com/");
	// pi can end the notebook scrolled to its notes, past the chart.
	await live("notebook", "https://jupyter.org/try-jupyter/lab/", {
		show: async () => {
			// An open file browser leaves the chart small: close it, as its tab does.
			document.querySelector(".jp-SideBar.jp-mod-left .lm-TabBar-tab.lm-mod-current")?.click();
			await new Promise((resolve) => setTimeout(resolve, 500));
			document.querySelector(".jp-OutputArea-output img")?.scrollIntoView({ block: "center" });
		},
	});
	await live("summary", "https://paulgraham.com/greatwork.html");
	// JSFiddle's ad covers the result, and blocking it stops the editors from loading: close it, as a user would, also
	// after pi reloads the page.
	await live("app", "https://jsfiddle.net/", {
		prepare: async (page) => {
			const close = () => setInterval(() => document.querySelector("#_stickybox_ .native-hide")?.click(), 500);
			await page.addInitScript(close);
			await page.evaluate(close);
		},
	});
	await live("issues", "https://github.com/microsoft/vscode/issues");

	// Table: one script reads a table of Wikipedia, counts its rows by decade, and marks the 2020s; the answer's numbers
	// and chart are what the script returned.
	if (scene("table")) {
		const table = await open(chrome, FILMS, (page) =>
			page.evaluate(() => {
				const table = document.querySelector("table.wikitable.sortable");
				scrollTo(0, table.getBoundingClientRect().top + scrollY - 8);
			}),
		);
		await play([{ tool: "run_script", args: { code: tableCode, summary: text.table.summary } }, { later: true }]);
		await send(
			chrome,
			table.panel,
			text.table.ask,
			finished(table.panel, ".msg.assistant .diagram img"),
			"the chart",
			{
				later: async () => {
					const ran = await lastResult(chrome);
					if (!ran.ok) throw Error(`The script failed: ${ran.error.message}`);
					if (ran.value.total < 40 || ran.value.recent === 0)
						throw Error(`Unexpected counts: ${JSON.stringify(ran.value)}`);
					return [text.table.answer(ran.value), "", decadeChart(ran.value.decades, text.table.chart)].join("\n");
				},
			},
		);
		await save(table.page, table.panel, { head: text.heads.table, file: `${prefix}table.png` });
	}

	// Issue: the user attaches a screenshot of an error; pi searches Vite's issues, opens the error's own, and answers
	// from it. The answer's issue and fix are checked on the pages pi read.
	if (scene("issue")) {
		const issue = await open(chrome, `${VITE}/issues`);
		const query = "is:issue+externalized+path.dirname";
		await play([
			go(text.issue.search, `${VITE}/issues?q=${query}`),
			{ ...read(), pause: 3000 },
			go(text.issue.open, `${VITE}/issues/${ISSUE}`),
			{ ...read(), pause: 3000 },
			{ later: true },
		]);
		await issue.panel.locator("#attach-input").setInputFiles({
			name: "error.png",
			mimeType: "image/png",
			buffer: await errorImage(),
		});
		await poll(async () => (await issue.panel.locator("#attachments .thumb img").count()) === 1, "the attachment");
		await send(chrome, issue.panel, text.issue.ask, finished(issue.panel, ".msg.assistant strong"), "the issue", {
			later: async () => {
				const [found, opened] = await chrome.worker.evaluate(() =>
					globalThis.__piShots.context.messages
						.filter((message) => message.role === "toolResult" && message.toolName === "read_page")
						.map((message) => message.content.map((block) => block.text ?? "").join("")),
				);
				if (!found.includes(String(ISSUE))) throw Error(`#${ISSUE} is not among the search results:\n${found}`);
				if (!opened.includes(String(FIX)) || !/closed/i.test(opened))
					throw Error(`#${ISSUE} no longer says it was closed by #${FIX}:\n${opened.slice(0, 2000)}`);
				return text.issue.answer;
			},
		});
		await issue.page.evaluate(() => scrollTo(0, 0));
		await save(issue.page, issue.panel, { head: text.heads.issue, file: `${prefix}issue.png` });
	}

	if (scene("explain")) {
		// Explain: a question about a selected paragraph of MDN, answered with a diagram.
		const explain = await open(chrome, MDN, (page) =>
			page.evaluate((quote) => {
				const paragraph = [...document.querySelectorAll("main p")].find((p) => p.textContent.startsWith(quote));
				paragraph.scrollIntoView({ block: "center" });
				const range = document.createRange();
				range.selectNodeContents(paragraph);
				getSelection().removeAllRanges();
				getSelection().addRange(range);
			}, QUOTE),
		);
		if (LIVE === undefined) await play([{ text: text.explain.answer }]);
		const done = LIVE === undefined ? ".msg.assistant .diagram img" : ".msg.assistant:not(.step-note)";
		await send(chrome, explain.panel, text.explain.ask, finished(explain.panel, done), "the diagram", {
			ms: 15 * 60_000,
		});
		await save(explain.page, explain.panel, {
			head: text.heads.explain,
			file: `${prefix}explain.png`,
			end: LIVE !== undefined,
		});
	}

	if (scene("rank")) {
		// Rank: one script reads every story on Hacker News's front page, ranks them by comments, and marks the top 5;
		// the table is what the script returned. The page is loaded once: no other page of the site is requested.
		// Hacker News asks for 30 s between automated requests: the other language's run opened it too.
		await sleep(Math.max(0, hnOpened + 30_000 - Date.now()));
		hnOpened = Date.now();
		const rank = await open(chrome, HN);
		await play([{ tool: "run_script", args: { code: rankCode, summary: text.rank.summary } }, { later: true }]);
		await send(chrome, rank.panel, text.rank.ask, finished(rank.panel, ".msg.assistant table"), "the stories", {
			later: async () => {
				const ran = await lastResult(chrome);
				if (!ran.ok) throw Error(`The script failed: ${ran.error.message}`);
				const { stories, top } = ran.value;
				const counts = top.flatMap(({ points, comments }) => [points, comments]);
				if (stories < 20 || top.length !== 5 || !counts.every(Number.isInteger))
					throw Error(
						`Unexpected result: ${JSON.stringify(ran.value)}\n${await rank.page.evaluate(() => document.body.textContent.slice(0, 500))}`,
					);
				const cut = (title) => (title.length > 26 ? `${title.slice(0, 25).trimEnd()}…` : title);
				const cell = (title) => cut(title).replace(/[|\\*_`[\]<>]/g, (c) => `\\${c}`);
				const rows = top.map((story) => `| ${cell(story.title)} | ${story.points} | ${story.comments} |`);
				return [text.rank.answer(stories), "", text.rank.head, ...rows].join("\n");
			},
		});
		await rank.page.evaluate(() => scrollTo(0, 0));
		await save(rank.page, rank.panel, { head: text.heads.rank, file: `${prefix}rank.png` });
	}

	if (scene("chart")) {
		// Chart: pi takes a screenshot of the chart and reads the trend off it; the chart's data gives the numbers, rounded
		// as one reads them off a line.
		const data = await renewables();
		const chart = await open(
			chrome,
			`${CHART}?tab=chart&time=2010..latest&country=${COUNTRIES.join("~")}`,
			async (page) => {
				const reject = page.getByRole("button", { name: "Reject optional cookies" });
				if (await reject.count()) await reject.click();
				await page.evaluate(() => {
					const title = [...document.querySelectorAll("h1, h2, h3, header *")].find((each) =>
						each.textContent.trim().startsWith("Share of electricity generation from renewables"),
					);
					scrollTo(0, title.getBoundingClientRect().top + scrollY - 16);
				});
				await sleep(1000);
			},
		);
		const { names } = text.chart;
		const [top, ...others] = data.shares.map((share) => ({ ...share, name: names[share.code] }));
		await play([{ tool: "screenshot_page", args: {} }, { later: true }]);
		// The screenshot is of the tab in front.
		await chart.page.bringToFront();
		await send(chrome, chart.panel, text.chart.ask, finished(chart.panel, ".msg.assistant ul"), "the chart", {
			later: async () =>
				[
					text.chart.answer(top, data.from, data.to),
					"",
					...others.map((other) => `- ${other.name}: ${other.from}% → ${other.to}%`),
				].join("\n"),
		});
		await save(chart.page, chart.panel, { head: text.heads.chart, file: `${prefix}chart.png` });
	}

	if (scene("control")) {
		// Control: the user asks for a filter on GitHub; pi looks for it, and the card asks before pi clicks.
		const control = await open(chrome, ISSUES);
		const [find, labels] = text.control.labels;
		await play([observe(find), act(text.control.summary, { action: "click" }, labels)]);
		await send(
			chrome,
			control.panel,
			text.control.ask,
			async () => (await control.panel.locator(".ask button.primary").count()) === 1,
			"the card",
			{ answer: () => false },
		);
		await save(control.page, control.panel, { head: text.heads.control, file: `${prefix}control.png` });
	}

	if (scene("translate")) {
		// Translate: the README's saved prompt, from the menu for the selected lead of an article; one script puts each
		// translation under its paragraph, as the prompt asks.
		const { name, template, summary, url, lead, above, lines, answer } = text.translate;
		await chrome.worker.evaluate(
			({ name, template }) =>
				globalThis.__piShots.saveSettings({
					prompts: [...globalThis.__piShots.PRESETS, { id: "translate-in-page", name, template }],
				}),
			{ name, template },
		);
		/** The lead, `above` px below the top; with `select`, the lead selected. Gives the selection's text. */
		const show = (page, select) =>
			page.evaluate(
				({ lead, above, select }) => {
					const paragraphs = [...document.querySelectorAll("#mw-content-text p")];
					const plain = (text) =>
						text
							.replace(/\[\d+\]/g, "")
							.replace(/\s+/g, " ")
							.trim();
					const matched = lead.map(({ start, text }) => {
						const found = paragraphs.find((p) => p.textContent.trim().startsWith(start));
						if (found === undefined || plain(found.textContent) !== plain(text))
							throw Error(`The article's lead has changed: ${found?.textContent ?? start}`);
						return found;
					});
					const [first, last] = [matched[0], matched.at(-1)];
					scrollTo(0, first.getBoundingClientRect().top + scrollY - above);
					getSelection().removeAllRanges();
					if (!select) return "";
					const range = document.createRange();
					range.setStartBefore(first);
					range.setEndAfter(last);
					getSelection().addRange(range);
					return getSelection().toString();
				},
				{ lead, above, select },
			);
		const translate = await open(chrome, url, (page) => show(page, true));
		const code = `const translations = ${JSON.stringify(
			lead.map(({ start }, i) => [start, lines[i]]),
			null,
			2,
		)};
const paragraphs = [...document.querySelectorAll("#mw-content-text p")];
let placed = 0;
for (const [start, translation] of translations) {
  const original = paragraphs.find((p) => p.textContent.trim().startsWith(start));
  if (!original) continue;
  const p = document.createElement("p");
  p.textContent = translation;
  original.after(p);
  placed++;
}
return { placed };`;
		if (LIVE === undefined) await play([{ tool: "run_script", args: { code, summary } }, { later: true }]);
		const done = LIVE === undefined ? ".msg.assistant p" : ".msg.assistant:not(.step-note)";
		await send(chrome, translate.panel, "", finished(translate.panel, done), "the translation", {
			ms: 15 * 60_000,
			// As a right-click on the selection, then the prompt in pi's menu.
			start: async () => {
				const selectionText = await show(translate.page, true);
				await chrome.worker.evaluate(
					async ({ tabId, selectionText }) => {
						const tab = await chrome.tabs.get(tabId);
						const gesture = { frameId: 0, url: tab.url, top: tab.url, selectionText, editable: false };
						const started = globalThis.__piShotsMain.begin("context-menu", tab, gesture);
						await globalThis.__piShotsMain.askSelection(
							"context-menu",
							started,
							crypto.randomUUID(),
							"translate-in-page",
						);
					},
					{ tabId: translate.tabId, selectionText },
				);
			},
			later:
				LIVE !== undefined
					? undefined
					: async () => {
							const ran = await lastResult(chrome);
							if (!ran.ok || ran.value.placed !== lead.length)
								throw Error(`The script placed: ${JSON.stringify(ran)}`);
							return answer;
						},
		});
		await show(translate.page, false);
		await save(translate.page, translate.panel, {
			head: text.heads.translate,
			file: `${prefix}translate.png`,
			end: LIVE !== undefined,
		});
	}
}

/**
 * A copy of the extension whose only catalog is `locale`: Chrome on macOS takes the interface language from the system,
 * not from --lang, so each copy shows its language whatever the system's is.
 */
function localized(locale) {
	const copy = join(dir, `ext-${locale}`);
	cpSync(ext, copy, { recursive: true });
	for (const other of readdirSync(join(copy, "_locales")))
		if (other !== locale) rmSync(join(copy, "_locales", other), { recursive: true });
	writeFileSync(join(copy, "manifest.json"), JSON.stringify({ ...manifest, default_locale: locale }));
	return copy;
}

const contexts = [];
try {
	const locales = process.env.LOCALES?.split(",") ?? ["en", "zh_CN"];
	if (locales.includes("en")) await shots("en", "en-US", "");
	// For the store's Chinese listing.
	if (locales.includes("zh_CN")) await shots("zh_CN", "zh-CN", "zh-CN-");
} finally {
	for (const context of contexts) await context.close();
	rmSync(dir, { recursive: true, force: true });
}
