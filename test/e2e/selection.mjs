// Native selection extraction and production panel/chat checks. Only loopback pages and an in-process faux
// provider, in a disposable Chrome profile and temporary bundle. No installed dist/, accounts, or paid requests.
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
const dir = mkdtempSync(join(tmpdir(), "pi-selection-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
// Existing UI assertions use English. The dedicated localization runner tests both unmodified catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
// Fixed test grants only. The foreign loopback frame is scriptable, but must still be excluded by reader policy.
manifest.host_permissions = [
	"http://127.0.0.1/*",
	"http://localhost/*",
	"https://openrouter.ai/*",
	"https://api.openai.com/*",
];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { credentials, models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { RECOMMENDED_MODELS } from ${JSON.stringify(join(repo, "src/shared/protocol.ts"))};
import { saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { chromePageAccess, planFrames } from ${JSON.stringify(join(repo, "src/background/page.ts"))};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "selection-test" }] });
models.setProvider(faux.provider);
const results = [], requests = [], searchRequests = [];
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.openai.com/v1/responses") throw Error("Unexpected network request in selection test");
  const payload = JSON.parse(init.body);
  searchRequests.push(payload);
  const annotations = payload.tools?.some(tool => tool.type === "web_search")
    ? [{ type: "url_citation", start_index: 0, end_index: 9, url: "https://example.com/source", title: "Fixture source" }] : [];
  const item = { type: "message", id: "msg_search", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "A source.", annotations }] };
  const events = [
    { type: "response.created", response: { id: "resp_search" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "A source." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_search", status: "completed", output: [item],
      usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 } } },
  ];
  return new Response(events.map(event => 'event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } });
};
globalThis.__piSelection = {
  access: chromePageAccess, planFrames, results, requests, searchRequests, state: faux.state, saveSettings,
  /** A fabricated ChatGPT sign-in, then an API key again: what the usage line's window follows. */
  async signIn() {
    await credentials.modify("openai", async () => ({ type: "oauth", access: "at-fabricated", refresh: "rt-fabricated",
      expires: Date.now() + 3_600_000, clientId: "oaiapp_fabricated", subject: "user-1",
      email: "someone@example.com" }));
  },
  async useKey() {
    await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-proj-fabricated" }));
  },
  async useOpenAI(tabId, rev) {
    await credentials.modify("openai", async () => ({ type: "api_key", key: "sk-proj-fabricated" }));
    await globalThis.__piSelectionMain.run({ type: "set-model", rev,
      model: { provider: "openai", modelId: RECOMMENDED_MODELS.openai } }, tabId);
  },
  script(calls) {
    results.length = requests.length = 0;
    const record = transcript => {
      requests.push(transcript);
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult") results.push(last);
    };
    faux.setResponses([
      ...calls.map(args => transcript => { record(transcript); return fauxAssistantMessage(fauxToolCall("read_page", args), { stopReason: "toolUse" }); }),
      transcript => { record(transcript); return fauxAssistantMessage("Checked with the faux provider."); },
    ]);
  },
};
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
					contents: `${readFileSync(path, "utf8")}\nglobalThis.__piSelectionMain = { begin, run };`,
					loader: "ts",
					resolveDir: join(repo, "src/background"),
				}));
			},
		},
	],
});
await build({
	...common,
	entryPoints: { panel: "src/panel/panel.ts" },
	outdir: ext,
	footer: { js: "globalThis.__piSelectionPanel = () => state;" },
});

let origin;
const site = createServer((req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	if (req.url === "/frame")
		return res.end('<!doctype html><title>Frame</title><p id="frameText">before FRAME SELECTED after</p>');
	const title = req.url === "/second" ? "Second fixture" : "Selection fixture";
	res.end(`<!doctype html><title>${title}</title>
<style>body { font: 16px sans-serif } iframe { width: 400px; height: 120px }</style>
<p id="simple">before <b id="words">chosen 😀 words</b> after</p>
<div id="privacy">VISIBLE START<span hidden>HIDDEN-SECRET</span><span style="visibility:hidden">INVISIBLE-SECRET</span>
<textarea>TEXTAREA-SECRET</textarea><input value="INPUT-SECRET"><input type="password" value="PASSWORD-SECRET">
<select><option>OPTION-SECRET</option></select><script type="text/plain">SCRIPT-SECRET</script><style>/* STYLE-SECRET */</style> VISIBLE END</div>
<p id="cross">prefix START</p><div id="open"><span slot="label">slotted label</span></div><div id="closed"></div>
<pre id="code">first\n    second\nlast</pre>
<div id="contents" style="display:contents">contents words</div>
<div id="hidden" hidden>HIDDEN-ONLY</div>
<div style="visibility:hidden">hidden ancestor <b id="restored" style="visibility:visible">visible child</b></div>
<figure id="figure"><img alt="unselected image alt" width="100" height="100"><figcaption id="caption">caption words</figcaption></figure>
<figure><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="hidden caption image" width="100" height="100"><figcaption hidden>CAPTION-HIDDEN-SECRET<script type="text/plain">CAPTION-SCRIPT-SECRET</script><textarea>CAPTION-TEXTAREA-SECRET</textarea></figcaption></figure>
<figure><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="drawn caption image" width="100" height="100"><figcaption>shown caption<span hidden>CAPTION-SPAN-SECRET</span><textarea>CAPTION-FIELD-SECRET</textarea><script type="text/plain">CAPTION-CODE-SECRET</script></figcaption></figure>
<span id="label" hidden>hidden label<script type="text/plain">LABEL-SCRIPT-SECRET</script><textarea>LABEL-FIELD-SECRET</textarea></span>
<div role="img" aria-labelledby="label" style="width: 60px; height: 60px; background: #888"></div>
<iframe id="same" src="/frame"></iframe><iframe id="foreign" src="${origin.replace("127.0.0.1", "localhost")}/frame"></iframe>
<iframe id="invisible" hidden src="/frame"></iframe>
<p id="footer">WHOLE PAGE FOOTER</p>
<script>
window.roots = {};
for (const mode of ["open", "closed"]) {
  const root = document.getElementById(mode).attachShadow({ mode });
  root.innerHTML = '<p id="shadow">SHADOW '+mode+' text</p><slot name="label"></slot>';
  window.roots[mode] = root;
}
window.select = (node, start, end) => {
  document.activeElement?.blur();
  const selection = getSelection(), range = document.createRange();
  selection.removeAllRanges();
  if (start === undefined) range.selectNodeContents(node);
  else { range.setStart(node, start); range.setEnd(node, end); }
  selection.addRange(range);
};
</script>`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${site.address().port}`;
let context;
let checks = 0;
function check(name, ok) {
	assert(ok, name);
	console.log(`PASS ${name}`);
	checks++;
}
async function poll(test, name) {
	const end = Date.now() + 20_000;
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
		args: [
			"--headless=new",

			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--no-proxy-server",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP localhost 127.0.0.1, MAP ungranted.test 127.0.0.1, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND",
		],
	});
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url());
		return url.protocol === "chrome-extension:" || ["127.0.0.1", "localhost", "ungranted.test"].includes(url.hostname)
			? route.continue()
			: route.abort();
	});
	const worker = await poll(() => context.serviceWorkers().find((w) => w.url().endsWith("/background.js")), "worker");
	const id = new URL(worker.url()).host;
	console.log("Chrome:", context.browser().version());
	assert.equal(await worker.evaluate(() => chrome.i18n.getMessage("localeCode")), "en");
	assert(Number.parseInt(context.browser().version(), 10) >= 140);
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piSelection)).catch(() => false), "hooks");
	await worker.evaluate(async () => {
		await chrome.storage.local.set({
			credentials: { openrouter: { type: "api_key", key: "not-a-real-key" } },
		});
		await globalThis.__piSelection.saveSettings({ model: { provider: "openrouter", modelId: "selection-test" } });
		await globalThis.__piSelectionMain.run(
			{
				type: "set-settings",
				settings: {
					language: "Chinese",
					tools: { read: "on", observe: "off", act: "off", script: "off", screenshot: "off" },
				},
			},
			null,
		);
	});
	const page = await context.newPage();
	await page.goto(origin);
	const tabId = await worker.evaluate(
		async (origin) => (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/`).id,
		origin,
	);
	const read = async (scope = "selection", frameId = 0, chars = 200_000, budget = 6000) =>
		worker.evaluate(
			async ({ tabId, scope, frameId, chars, budget }) => {
				const access = globalThis.__piSelection.access;
				const frame = (await access.frames(tabId)).find((frame) => frame.frameId === frameId);
				return access.text(tabId, frame.documentId, chars, budget, scope);
			},
			{ tabId, scope, frameId, chars, budget },
		);
	const select = (selector) => page.evaluate((selector) => window.select(document.querySelector(selector)), selector);
	await page.evaluate(() => window.select(document.querySelector("#words").firstChild, 7, 15));
	assert.equal((await read()).text, "😀 words");
	check("exact partial text and Unicode", true);
	check("default page scope ignores the selection", (await read("page")).text.includes("WHOLE PAGE FOOTER"));
	// An image's marker by the reader's rules: a caption only as drawn, a name from a hidden label without its
	// scripts or fields.
	const whole = (await read("page")).text;
	check(
		"a hidden caption is left out of its image's marker",
		whole.includes('[image "hidden caption image" 100×100]'),
	);
	check(
		"a drawn caption keeps only its drawn text",
		whole.includes('[image "drawn caption image" 100×100 caption "shown caption"]'),
	);
	check("a name from a hidden label keeps its text", whole.includes('[image "hidden label" 60×60]'));
	check("no hidden, field, or script text of a caption or label", !/(CAPTION|LABEL)-\w+-SECRET/.test(whole));
	await select("#privacy");
	const privateRead = await read();
	check(
		"selected visible text is kept",
		privateRead.text.includes("VISIBLE START") && privateRead.text.includes("VISIBLE END"),
	);
	check("hidden text, field values, options, scripts and styles stay out", !privateRead.text.includes("SECRET"));
	for (const selector of ["#hidden", "textarea", "select"]) {
		await select(selector);
		check(`no readable selection in ${selector}`, (await read()).text === "");
	}
	await select("#words");
	for (const selector of ["input", "textarea", 'input[type="password"]']) {
		await page.locator(selector).first().focus();
		check(`focused ${selector} never substitutes stale body selection`, (await read()).text === "");
	}
	for (const [selector, expected] of [
		["#code", "first\n    second\nlast"],
		["#contents", "contents words"],
		["#restored", "visible child"],
		["#caption", "caption words"],
	]) {
		await select(selector);
		assert.equal((await read()).text, expected);
		check(`selection formatting ${selector}`, true);
	}
	check("selection does not add media markers or alt text", !(await read()).text.includes("image"));
	for (const mode of ["open", "closed"]) {
		await page.evaluate(
			(mode) => window.select(window.roots[mode].querySelector("#shadow").firstChild, 7, 7 + mode.length),
			mode,
		);
		assert.equal((await read()).text, mode);
		check(`${mode} shadow-root selection`, true);
	}
	await page.evaluate(() => window.select(document.querySelector('[slot="label"]').firstChild, 0, 7));
	assert.equal((await read()).text, "slotted");
	check("slotted selection is not duplicated", true);
	// Chromium's programmatic setBaseAndExtent collapses a cross-root range; use a real drag here.
	const points = await page.evaluate(() =>
		[
			[document.querySelector("#cross").firstChild, 7],
			[window.roots.open.querySelector("#shadow").firstChild, 6],
		].map(([node, offset]) => {
			const range = document.createRange();
			range.setStart(node, offset);
			range.collapse(true);
			const box = range.getBoundingClientRect();
			return { x: box.x, y: box.y + box.height / 2 };
		}),
	);
	for (const backwards of [false, true]) {
		const [start, end] = backwards ? [...points].reverse() : points;
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(end.x, end.y, { steps: 10 });
		await page.mouse.up();
		assert.equal((await read()).text, "START\nSHADOW");
		check(`${backwards ? "backwards " : ""}selection crossing a shadow boundary`, true);
	}
	await page.evaluate(() => getSelection().removeAllRanges());
	check("no selection returns no page text", (await read()).text === "");
	await select("#words");
	await page.locator("#same").focus();
	const same = page.frames().find((frame) => frame.url() === `${origin}/frame`);
	await same.evaluate(() => {
		const text = document.querySelector("#frameText").firstChild;
		getSelection().setBaseAndExtent(text, 7, text, 21);
	});
	const frames = await worker.evaluate((tabId) => globalThis.__piSelection.access.frames(tabId), tabId);
	const sameFrame = frames.find((frame) => frame.url === `${origin}/frame` && frame.shown);
	check("parent ignores its stale selection when a child frame is active", (await read()).text === "");
	assert.equal((await read("selection", sameFrame.frameId)).text, "FRAME SELECTED");
	check("current same-origin frame selection", true);
	const plan = await worker.evaluate((frames) => globalThis.__piSelection.planFrames(frames), frames);
	check(
		"same-origin and visibility limits remain",
		plan.others.length === 1 && plan.others[0].frameId === sameFrame.frameId,
	);
	await page.evaluate(() => {
		document.querySelector("#same").blur();
		window.select(document.querySelector("#words"));
	});
	check("inactive frame ignores its retained selection", (await read("selection", sameFrame.frameId)).text === "");
	const capped = await read("selection", 0, 8);
	check("selection cap does not split a surrogate pair", capped.text === "chosen " && capped.length === 15);
	await page.evaluate(() => {
		const div = document.createElement("div");
		for (let n = 0; n < 600; n++) div.append(document.createElement("span"));
		document.body.append(div);
		window.select(document.querySelector("#words"));
	});
	check(
		"expired selection walk is incomplete, not a whole-page fallback",
		(await read("selection", 0, 200_000, -1)).complete === false,
	);

	// Production panel, connection, capture, native IndexedDB, Chats, page tool, and faux provider together.
	await worker.evaluate(async (tabId) => {
		const tab = await chrome.tabs.get(tabId);
		const started = globalThis.__piSelectionMain.begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
		await Promise.all([started.captured, started.resolved]);
	}, tabId);
	const panel = await context.newPage();
	panel.on("pageerror", (error) => console.error("PANEL ERROR", error));
	await panel.goto(`chrome-extension://${id}/panel.html?tab=${tabId}`);
	const summary = panel.getByRole("button", { name: "Summarize page", exact: true });
	await summary.waitFor({ state: "visible" });
	// biome-ignore lint/performance/useDomNodeTextContent: Preserve the rendered attached-page heading assertion.
	assert.equal(await panel.locator(".empty h3").innerText(), "Give pi a task on this page.");
	assert.equal(await panel.locator(".empty p").isVisible(), false);
	assert.equal(await panel.locator("#composer").getAttribute("placeholder"), "Ask pi");
	check("attached empty state is task-first, with no entry-point instructions", true);
	check(
		"a new chat has no usage or context line",
		(await panel.locator("#chat-usage").textContent()) === "" && !(await panel.locator("#chat-usage").isVisible()),
	);
	await panel.locator("#detach-page").click();
	// biome-ignore lint/performance/useDomNodeTextContent: Preserve the rendered detached-chat heading assertion.
	assert.equal(await panel.locator(".empty h3").innerText(), "Ask pi");
	// biome-ignore lint/performance/useDomNodeTextContent: Preserve the rendered detached-chat hint assertion.
	assert.equal(await panel.locator(".empty p").innerText(), "Type a question to get started.");
	check("detached empty state hides summary", !(await summary.isVisible()));
	// A fresh panel clears only its local detachment, not any production tab/page state.
	await panel.reload();
	await summary.waitFor({ state: "visible" });
	for (const language of ["Chinese", "English"]) {
		await panel.locator("#open-settings").click();
		await panel.locator("#language").selectOption(language);
		await poll(
			() => panel.evaluate((language) => globalThis.__piSelectionPanel()?.settings.language === language, language),
			"reply language",
		);
		await panel.locator("#close-settings").click();
		await worker.evaluate(() => globalThis.__piSelection.script([{}]));
		await summary.click();
		await poll(() => worker.evaluate(() => globalThis.__piSelection.results.length === 1), "summary result");
		const sent = await worker.evaluate(() => ({
			messages: globalThis.__piSelection.requests[0].messages,
			result: globalThis.__piSelection.results[0],
		}));
		const input = sent.messages.findLast((message) => message.role === "user");
		const text =
			typeof input.content === "string" ? input.content : input.content.map((part) => part.text ?? "").join("");
		check(
			`summary requests the current ${language} reply language`,
			text.includes(`Answer in ${language}.`) && text.includes("whole page"),
		);
		check(
			`summary in ${language} reads the whole page despite a selection`,
			sent.result.content.some((part) => part.type === "text" && part.text.includes("WHOLE PAGE FOOTER")),
		);
		await poll(() => panel.locator("#new-chat").isEnabled(), "chat admitted");
		await panel.locator("#new-chat").click();
		await summary.waitFor({ state: "visible" });
	}
	await worker.evaluate(() => globalThis.__piSelection.script([{ scope: "selection" }, {}]));
	await panel.locator("#composer").fill("Explain the selected text, then summarize the whole page.");
	await panel.locator("#send").click();
	await poll(() => worker.evaluate(() => globalThis.__piSelection.results.length === 2), "both read scopes");
	const results = await worker.evaluate(() =>
		globalThis.__piSelection.results.map((result) => JSON.parse(result.content[0].text)),
	);
	assert.equal(results[0].text, "chosen 😀 words");
	check("production read_page selection scope returns only selected body text", results[0].scope === "selection");
	check(
		"production read_page keeps a separate whole-page snapshot",
		results[1].text.includes("WHOLE PAGE FOOTER") && results[0].snapshotId !== results[1].snapshotId,
	);
	// New chat: current page metadata, not a new content read or an implicit attach gesture.
	const state = () => panel.evaluate(() => globalThis.__piSelectionPanel());
	const idle = () =>
		poll(async () => {
			const current = await state();
			return !current.chat.busy && current.chat.entries.at(-1)?.role === "assistant";
		}, "chat idle");
	const ask = async (text) => {
		await worker.evaluate(() => globalThis.__piSelection.script([]));
		await panel.locator("#composer").fill(text);
		await panel.locator("#send").click();
		await idle();
	};
	const fresh = async () => {
		const rev = (await state()).rev;
		await panel.locator("#new-chat").click();
		await poll(async () => (await state()).rev === rev + 1, "new chat revision");
		assert.equal(await panel.locator("#chat-usage").textContent(), "", "New chat clears usage and context");
		assert.equal(await panel.locator("#chat-usage").isVisible(), false, "empty usage stays hidden");
	};
	const attached = (url, title) =>
		poll(async () => {
			const current = await state();
			return current.page?.url === url && current.page.title === title && current.page;
		}, `attachment ${url}`);
	await idle();
	check(
		"chat usage includes numeric current context/window without an auto suffix",
		/\d+\.\d+%\/[\d.]+[kM]?$/.test(await panel.locator("#chat-usage").textContent()) &&
			(await state()).chat.context.tokens > 0 &&
			(await state()).chat.context.auto === true,
	);
	const firstChat = (await state()).chat.conversationId;
	const secondUrl = `${origin}/second`;
	await page.goto(secondUrl);
	check("navigation alone does not rewrite existing message context", (await state()).page.url === `${origin}/`);
	await fresh();
	let currentPage = await attached(secondUrl, "Second fixture");
	check(
		"New chat captures the current link and title after same-tab navigation",
		currentPage.frameId === 0 && currentPage.documentId !== null,
	);
	await ask("Question about the second page.");
	check(
		"the new chat sends the current page source",
		(await state()).chat.entries.find((entry) => entry.role === "user").source.url === secondUrl,
	);
	const history = await worker.evaluate(
		(tabId) => globalThis.__piSelectionMain.run({ type: "list-chats" }, tabId),
		tabId,
	);
	check(
		"old History sources keep their original URL and title",
		history.find((chat) => chat.id === firstChat)?.page.url === `${origin}/` &&
			history.find((chat) => chat.id === firstChat)?.page.title === "Selection fixture",
	);
	const beforeReload = currentPage.documentId;
	await page.reload();
	await fresh();
	currentPage = await attached(secondUrl, "Second fixture");
	check("New chat refreshes the document ID after reload", currentPage.documentId !== beforeReload);
	await ask("Before the SPA route changes.");
	await page.evaluate(() => {
		history.pushState({}, "", "/route#state");
		document.title = "SPA route";
	});
	await fresh();
	const routed = await attached(`${origin}/route#state`, "SPA route");
	check(
		"New chat follows SPA URL/title changes in the same document",
		routed.documentId === currentPage.documentId && routed.key.endsWith("/route#state"),
	);
	await ask("Before refreshing metadata with field access blocked.");
	// Poison content/focus getters in the extension's isolated world. A metadata-only refresh must not touch them.
	await worker.evaluate(
		(tabId) =>
			chrome.scripting.executeScript({
				target: { tabId, frameIds: [0] },
				func: () => {
					const saved = [];
					for (const [object, name] of [
						[Document.prototype, "activeElement"],
						[HTMLInputElement.prototype, "value"],
						[HTMLTextAreaElement.prototype, "value"],
						[HTMLElement.prototype, "innerText"],
					]) {
						const descriptor = Object.getOwnPropertyDescriptor(object, name);
						saved.push([object, name, descriptor]);
						Object.defineProperty(object, name, {
							configurable: true,
							get() {
								throw Error(`Unexpected content/focus read: ${name}`);
							},
						});
					}
					const selection = window.getSelection;
					window.getSelection = () => {
						throw Error("Unexpected selection read");
					};
					globalThis.__restoreMetadataTest = () => {
						for (const [object, name, descriptor] of saved) Object.defineProperty(object, name, descriptor);
						window.getSelection = selection;
					};
				},
			}),
		tabId,
	);
	try {
		await fresh();
		await attached(`${origin}/route#state`, "SPA route");
		check("New chat reads no body text, selections, focus, or form values", true);
	} finally {
		await worker.evaluate(
			(tabId) =>
				chrome.scripting.executeScript({
					target: { tabId, frameIds: [0] },
					func: () => globalThis.__restoreMetadataTest(),
				}),
			tabId,
		);
	}
	await ask("Before moving to a site without access.");
	const permissions = await worker.evaluate(() => chrome.permissions.getAll());
	const ungranted = origin.replace("127.0.0.1", "ungranted.test");
	await page.goto(`${ungranted}/second`);
	await fresh();
	await poll(async () => (await state()).page === null, "unreadable page detached");
	check(
		"a site without Chrome access leaves no stale attachment",
		!(await panel.locator("#page").isVisible()) && !(await summary.isVisible()),
	);
	assert.deepEqual(await worker.evaluate(() => chrome.permissions.getAll()), permissions);
	check("New chat requests no new permission", true);
	await ask("Plain question while the page is unavailable.");
	await page.goto(secondUrl);
	await fresh();
	await attached(secondUrl, "Second fixture");
	check("New chat can attach a readable page after an unavailable page", true);
	await ask("Before choosing Don't attach.");
	await panel.locator("#detach-page").click();
	await fresh();
	check(
		"New chat preserves Don't attach",
		(await state()).page === null && !(await panel.locator("#page").isVisible()),
	);
	await panel.reload();
	await poll(() => panel.evaluate(() => Boolean(globalThis.__piSelectionPanel())), "panel reconnected");
	check(
		"the detached New chat stays detached after panel reload",
		(await state()).page === null && !(await summary.isVisible()),
	);
	await worker.evaluate(async (tabId) => {
		const tab = await chrome.tabs.get(tabId);
		const started = globalThis.__piSelectionMain.begin("action", tab, { frameId: 0, url: tab.url, top: tab.url });
		await Promise.all([started.captured, started.resolved]);
	}, tabId);
	await attached(secondUrl, "Second fixture");
	await ask("A new explicit page gesture attaches again.");
	await fresh();
	await attached(secondUrl, "Second fixture");
	check("an explicit later page gesture enables future New chat refreshes", true);

	// Saved provider switch and native Responses annotations through the production panel and IndexedDB.
	await panel.locator("#open-settings").click();
	await panel.locator('[aria-controls="key-body-openai"]').click();
	const search = panel.getByRole("group", { name: "Web search", exact: true });
	const searchOn = search.getByRole("radio", { name: "On", exact: true });
	const searchOff = search.getByRole("radio", { name: "Off", exact: true });
	check(
		"OpenAI alone exposes Off/On Web search, default On",
		(await search.count()) === 1 &&
			(await searchOn.isChecked()) &&
			!(await searchOff.isChecked()) &&
			(await state()).settings.openaiWebSearch === true,
	);
	check(
		"the search setting discloses API-key charges",
		// biome-ignore lint/performance/useDomNodeTextContent: Check the rendered cost disclosure shown to the user.
		(await panel.locator("#key-body-openai .tool .note").innerText()) ===
			"Lets OpenAI search the web when needed. API-key searches cost extra.",
	);
	await worker.evaluate(() => {
		const set = chrome.storage.local.set.bind(chrome.storage.local);
		chrome.storage.local.set = async (items) => {
			if (items.settings !== undefined) {
				chrome.storage.local.set = set;
				throw Error("Test settings storage failure");
			}
			return set(items);
		};
	});
	// Click the label: the radios are visually hidden, and failure immediately restores On.
	await search.locator('label:has(> input[value="off"])').click();
	await poll(
		async () =>
			(await searchOn.isChecked()) &&
			!(await searchOff.isChecked()) &&
			(await state()).settings.openaiWebSearch === true &&
			(await panel.getByText("Not saved: Test settings storage failure", { exact: true }).isVisible()),
		"search save rollback",
	);
	check("a failed search save restores On in the segmented control and reports failure", true);
	await search.locator('label:has(> input[value="off"])').click();
	await poll(async () => (await state()).settings.openaiWebSearch === false, "search saved Off");
	await panel.reload();
	await panel.locator("#open-settings").click();
	await panel.locator('[aria-controls="key-body-openai"]').click();
	check(
		"Web search stays Off after panel reload",
		(await searchOff.isChecked()) &&
			!(await searchOn.isChecked()) &&
			(await state()).settings.openaiWebSearch === false,
	);
	await panel.locator("#close-settings").click();
	await worker.evaluate(({ tabId, rev }) => globalThis.__piSelection.useOpenAI(tabId, rev), {
		tabId,
		rev: (await state()).rev,
	});
	await panel.reload();
	await poll(async () => (await state())?.settings.model.provider === "openai", "native OpenAI model");
	await ask("An answer with web search disabled.");
	check(
		"Off omits hosted search from the native request",
		await worker.evaluate(
			() => !globalThis.__piSelection.searchRequests.at(-1).tools?.some((tool) => tool.type === "web_search"),
		),
	);
	await panel.locator("#open-settings").click();
	await panel.locator('[aria-controls="key-body-openai"]').click();
	await search.locator('label:has(> input[value="on"])').click();
	await poll(async () => (await state()).settings.openaiWebSearch === true, "search saved On");
	await panel.locator("#close-settings").click();
	await fresh();
	await ask("An answer with a search citation.");
	check(
		"On adds hosted search and source metadata to the native request",
		await worker.evaluate(() => {
			const payload = globalThis.__piSelection.searchRequests.at(-1);
			return (
				payload.tools.some((tool) => tool.type === "web_search") &&
				payload.include.includes("web_search_call.action.sources")
			);
		}),
	);
	const link = panel.locator('.md a[href="https://example.com/source"]');
	await link.waitFor({ state: "visible" });
	check(
		"native citations become safe clickable links",
		// biome-ignore lint/performance/useDomNodeTextContent: Keep the citation assertion on its rendered label.
		(await link.innerText()) === "1" &&
			(await link.getAttribute("target")) === "_blank" &&
			(await link.getAttribute("rel")) === "noopener noreferrer",
	);
	await panel.reload();
	await link.waitFor({ state: "visible" });
	check(
		"native citation links survive persistence and panel reload",
		(await state()).chat.entries.some(
			(entry) => entry.role === "assistant" && entry.text.includes("[1](https://example.com/source)"),
		),
	);

	// GPT-6.1 Sol has 272k by API key and the plan's 500k with a ChatGPT sign-in (design 6.20): an open panel's usage
	// line follows a switch of the credential, without a reload.
	await worker.evaluate(
		({ tabId, rev }) =>
			globalThis.__piSelectionMain.run(
				{ type: "set-model", rev, model: { provider: "openai", modelId: "gpt-6.1-sol" } },
				tabId,
			),
		{ tabId, rev: (await state()).rev },
	);
	await ask("An answer on the plan's model.");
	const usage = () => panel.locator("#chat-usage").textContent();
	await poll(async () => (await usage()).endsWith("/272k"), "the API's window");
	await worker.evaluate(() => globalThis.__piSelection.signIn());
	await poll(async () => (await state()).status.access.openai.plan, "the sign-in in the panel's status");
	await poll(async () => (await usage()).endsWith("/500k"), "the plan's window");
	check("after a ChatGPT sign-in, the usage line shows the plan's window", true);
	await worker.evaluate(() => globalThis.__piSelection.useKey());
	await poll(async () => (await usage()).endsWith("/272k"), "the API's window again");
	check("after an API key again, the API's window", true);
	console.log(`${checks} checks passed.`);
} catch (error) {
	if (context !== undefined) {
		for (const page of context.pages())
			if (page.url().startsWith("chrome-extension:"))
				console.error(
					"Panel on failure:",
					await page
						.locator("body")
						.textContent()
						.catch(() => "unavailable"),
				);
		const worker = context.serviceWorkers().find((worker) => worker.url().endsWith("/background.js"));
		const report = await worker
			?.evaluate(async () => ({
				state: globalThis.__piSelection?.state,
				requests: globalThis.__piSelection?.requests,
				results: globalThis.__piSelection?.results,
				storage: await chrome.storage.session.get(null),
			}))
			.catch(() => null);
		writeFileSync(join(dir, "failure.json"), JSON.stringify(report, null, 2));
	}
	throw error;
} finally {
	await context?.close();
	await new Promise((resolve) => site.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
