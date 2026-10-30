// Mermaid diagrams in the production panel (design 6.32): a faux model streams an answer with diagrams, and the run
// checks the pictures, their bounds, the fallbacks to code, the theme, the viewer, and the page's CSP. Only a loopback
// page and an in-process faux provider, in a disposable Chrome profile and temporary bundle; it writes light.png and
// dark.png to the artifacts folder. No installed dist/, accounts, or paid requests.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-diagrams-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
// Keep legacy English-label checks native; localization.mjs retains both full production catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*", "https://openrouter.ai/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

// pele lays out any diagram within the bounds in well under the render limit, so the worker built for this test holds
// a source that starts with SLOW past it, as a render that never ends would.
const SLOW = "%% slow";
const answer = [
	"A flowchart:",
	'```mermaid\ngraph TD\n  A[Start] --> B{OK?}\n  B -->|yes| C["<script>alert(1)</script>"]\n  B -->|no| A\n```',
	"A pie chart:",
	'```mermaid\npie\n  "a": 1\n  "b": 2\n```',
	"Not drawn by pele:",
	"```mermaid\nzenuml\n  Alice->Bob: Hello\n```",
	"Too slow to lay out:",
	`\`\`\`mermaid\n${SLOW}\ngraph LR\n  a --> b\n\`\`\``,
	"Too long:",
	`\`\`\`mermaid\ngraph TD\n${"  A --> B\n".repeat(1100)}\`\`\``,
	"Plain code:",
	"```js\nconst a = 1;\n```",
	"Done.",
].join("\n\n");
const sixth = "```mermaid\ngraph LR\n  X --> Y\n```";
const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "diagram-test" }], tokensPerSecond: 4000 });
models.setProvider(faux.provider);
globalThis.fetch = async () => { throw Error("Unexpected network request in diagram test"); };
globalThis.__piDiagrams = { saveSettings, answer: (text) => faux.setResponses([fauxAssistantMessage(text)]) };
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
			name: "test-only-main-hooks",
			setup(builder) {
				builder.onLoad({ filter: /\/background\/main\.ts$/ }, ({ path }) => ({
					contents: `${readFileSync(path, "utf8")}\nglobalThis.__piDiagramsMain = { begin };`,
					loader: "ts",
					resolveDir: join(repo, "src/background"),
				}));
			},
		},
	],
});
await build({
	...common,
	entryPoints: { panel: "src/panel/panel.ts", "diagram-worker": "src/panel/diagram-worker.ts" },
	outdir: ext,
	plugins: [
		{
			name: "test-only-slow-diagram",
			setup(builder) {
				// Registered before the worker's own listener, so it holds the worker before the render.
				builder.onLoad({ filter: /\/panel\/diagram-worker\.ts$/ }, ({ path }) => ({
					contents: `globalThis.addEventListener("message", (event) => {
	if (String(event.data?.source).startsWith(${JSON.stringify(SLOW)})) for (const end = Date.now() + 30_000; Date.now() < end; );
});
${readFileSync(path, "utf8")}`,
					loader: "ts",
					resolveDir: join(repo, "src/panel"),
				}));
			},
		},
	],
});

const site = createServer((_, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end("<!doctype html><title>Diagram fixture</title><p>A page.</p>");
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;
let context;
let checks = 0;
const problems = [];
function check(name, ok, detail = "") {
	assert(ok, `${name}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
	console.log(`PASS ${name}`);
	checks++;
}
async function poll(test, name, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = await test();
		if (value) return value;
		await sleep(50);
	}
	throw Error(`Timed out: ${name}`);
}
try {
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		viewport: { width: 400, height: 900 },
		args: [
			"--headless=new",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--no-proxy-server",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
		],
	});
	// Nothing leaves the machine: the panel's diagrams load nothing.
	const external = [];
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.protocol === "chrome-extension:" || url.protocol === "blob:" || url.hostname === "127.0.0.1")
			return route.continue();
		external.push(url.href);
		return route.abort();
	});
	const worker = await poll(() => context.serviceWorkers().find((w) => w.url().endsWith("/background.js")), "worker");
	const id = new URL(worker.url()).host;
	console.log("Chrome:", context.browser().version());
	assert.equal(await worker.evaluate(() => chrome.i18n.getMessage("localeCode")), "en");
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piDiagrams)).catch(() => false), "hooks");
	await worker.evaluate(async () => {
		await chrome.storage.local.set({ credentials: { openrouter: { type: "api_key", key: "not-a-real-key" } } });
		await globalThis.__piDiagrams.saveSettings({ model: { provider: "openrouter", modelId: "diagram-test" } });
	});
	const page = await context.newPage();
	await page.goto(origin);
	const tabId = await worker.evaluate(
		async (origin) => (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/`).id,
		origin,
	);
	await worker.evaluate(async (tabId) => {
		const tab = await chrome.tabs.get(tabId);
		const started = globalThis.__piDiagramsMain.begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
		await Promise.all([started.captured, started.resolved]);
	}, tabId);

	const panel = await context.newPage();
	panel.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	panel.on("console", (message) => {
		if (message.type() === "error" || /Content Security Policy/i.test(message.text()))
			problems.push(`console: ${message.text()} (${message.location().url})`);
	});
	await panel.goto(`chrome-extension://${id}/panel.html?tab=${tabId}`);
	await panel.locator("#composer").waitFor({ state: "visible" });
	await panel.locator("#detach-page").click();

	// Streaming: the first diagram shows while the answer is still live.
	await worker.evaluate((text) => globalThis.__piDiagrams.answer(text), `${answer}\n\n${sixth}`);
	await panel.locator("#composer").fill("Draw it.");
	await panel.locator("#send").click();
	await poll(() => panel.locator(".msg.live .diagram img").count(), "a diagram in the live answer");
	check("a closed fence is drawn while the answer streams", true);
	const answerBox = panel.locator(".msg.assistant").last();
	// Scrolled up as a user would; the transcript otherwise keeps to its end.
	const shot = async (name) => {
		const top = () =>
			answerBox
				.locator(".diagram")
				.first()
				.evaluate((diagram) => diagram.getBoundingClientRect().top);
		await answerBox.hover();
		await poll(async () => {
			const at = await top();
			if (at >= 40 && at < 200) return true;
			await panel.mouse.wheel(0, at < 40 ? -300 : 300);
			await sleep(100);
		}, "diagrams in view");
		await panel.screenshot({ path: join(dir, name) });
	};
	await poll(async () => (await panel.locator(".msg.live").count()) === 0, "answer finished", 60_000);
	await poll(async () => (await answerBox.locator(".diagram img").count()) === 2, "two pictures");

	const images = await answerBox
		.locator(".diagram img")
		.evaluateAll((all) =>
			all.map((image) => ({ src: image.src, width: image.naturalWidth, complete: image.complete, alt: image.alt })),
		);
	check(
		"flowchart and pie chart load as blob: SVG pictures",
		images.length === 2 && images.every((image) => image.src.startsWith("blob:") && image.width > 50),
		images,
	);
	const svg = await panel.evaluate(async (src) => (await fetch(src)).text(), images[0].src);
	check(
		"a label's markup is not an element in the SVG, its text is text",
		!/<script/i.test(svg) && svg.includes("alert(1)"),
	);
	const codes = await answerBox
		.locator(":scope > .md > .code pre")
		.evaluateAll((all) => all.map((pre) => [pre.className, pre.textContent.slice(0, 20)]));
	check(
		"zenuml, the too-slow, too-long and sixth diagrams, and plain code stay code",
		codes.length === 5 &&
			codes[0][1].startsWith("zenuml") &&
			codes[1][1].startsWith(SLOW) &&
			codes[2][1].startsWith("graph TD\n  A --> B") &&
			codes[3][0] === "" &&
			codes[4][1].startsWith("graph LR\n  X --> Y"),
		codes,
	);
	check(
		"those diagrams stay marked as Mermaid",
		(await answerBox.locator(":scope > .md > .code pre.mermaid").count()) === 4,
	);
	const sources = await answerBox.locator(".diagram .diagram-source").evaluateAll((all) =>
		all.map((details) => ({
			open: details.open,
			summary: details.querySelector("summary").textContent,
			code: details.querySelector("pre").textContent,
			copy: details.querySelector(".code > button") !== null,
		})),
	);
	check(
		"each picture keeps its source folded under Source, with Copy",
		sources.length === 2 &&
			sources.every((each) => !each.open && each.summary === "Source" && each.copy) &&
			sources[1].code.startsWith("pie"),
		sources,
	);
	const started = Date.now();
	await panel.evaluate(() => 1);
	check("the panel stays responsive while a diagram is too slow", Date.now() - started < 1000);
	await shot("light.png");

	await panel.emulateMedia({ colorScheme: "dark" });
	await poll(
		async () =>
			(await answerBox.locator(".diagram img").evaluateAll((all) => all.map((image) => image.src))).every(
				(src) => !images.some((image) => image.src === src),
			),
		"dark pictures",
	);
	const darkSvg = await panel.evaluate(
		async () => (await fetch(document.querySelector(".diagram img").src)).text(),
		undefined,
	);
	check("a theme switch draws the pictures again in the dark colors", darkSvg.includes("--pele-fg:#f5f5f7"));
	// The dark redraws queued behind SLOW, held for 30 s: they came within the 20 s poll only because the time limit ended
	// that worker, and SLOW, still code, did not finish in a later one.
	check(
		"a render past the time limit ends the worker, and its diagram stays code",
		(await answerBox.locator(".diagram img").count()) === 2 &&
			(await answerBox.locator(":scope > .md > .code pre.mermaid").count()) === 4,
	);
	await shot("dark.png");

	await answerBox.locator(".diagram-open").first().click();
	const viewer = await panel.evaluate(() => ({
		open: document.querySelector("#viewer").open,
		label: document.querySelector("#viewer").getAttribute("aria-label"),
		alt: document.querySelector("#viewer-image").alt,
		src: document.querySelector("#viewer-image").src,
		image: document.querySelector(".diagram img").src,
	}));
	check(
		"a click shows the diagram full size",
		viewer.open && viewer.label === "Diagram" && viewer.alt === "Diagram, full size" && viewer.src === viewer.image,
		viewer,
	);
	await panel.keyboard.press("Escape");

	check("no external requests", external.length === 0, external);
	check("no panel errors or CSP reports", problems.length === 0, problems);

	// A new chat frees the pictures (fetching a freed one logs an error, so this comes last).
	const old = images[0].src;
	await panel.locator("#new-chat").click();
	await poll(
		() =>
			panel.evaluate(
				(src) =>
					fetch(src).then(
						() => false,
						() => true,
					),
				old,
			),
		"pictures freed after a new chat",
	);
	check("showing another chat frees the pictures", true);

	console.log(`${checks} checks passed.`);
} catch (error) {
	console.error("Problems:", problems);
	for (const page of context?.pages() ?? [])
		if (page.url().startsWith("chrome-extension:"))
			console.error(
				"Panel on failure:",
				await page
					.locator("body")
					.textContent()
					.catch(() => "unavailable"),
			);
	throw error;
} finally {
	await context?.close();
	await new Promise((resolve) => site.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
