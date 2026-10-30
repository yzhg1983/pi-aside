// Page tools end to end (design 6.23): a scripted fake model calls observe_page, act_on_page, and run_script on
// loopback pages, and the run checks what the tools return and what the page saw. The outline (open and closed shadow
// roots, field states without field content, find); click, type into a field and a contenteditable, a key, a select,
// a password field and a covered button refused; a tab the user opens from a frame while pi acts, which pi does not
// take as its own; images whose caption or name holds hidden text, scripts, and fields; navigation on the page's
// origin and refused to another, and a ref gone after it; the site card after the user moves the tab to another site,
// naming the site of a link they followed but not one typed in the address bar, and the message's note of where the
// tab is; the Ask card's Allow and Deny. run_script: not offered while Chrome's Allow User Scripts switch is
// off; the switch turned on on pi's details page; the card's Run and Deny; a lone expression, a body with await and
// logs, pi's world kept between calls and the page's objects not seen, a throw, a page whose CSP allows no script, and
// Off. wait_on_page: a playing video's position, a text that shows and one hidden that never counts, a reload that
// ends a wait, and a wait that Chrome's stop of the worker cut off, which waits again for its first run's medium and
// deadline. No request leaves the machine.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome for Testing 140+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-page-tools-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
// The installed dist/ and the user's Chrome profile are never touched.
mkdirSync(ext);
const common = {
	absWorkingDir: repo,
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "chrome140",
	splitting: false,
	logLevel: "warning",
	outdir: ext,
};
await build({
	...common,
	entryPoints: { background: "src/background/main.ts" },
	// A test-only hook in the temporary worker bundle, not in production source.
	footer: { js: "globalThis.__piTest = { begin };" },
});
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts" } });
cpSync(join(repo, "static"), ext, { recursive: true });
// English labels; localization.mjs covers both catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = ["https://openrouter.ai/*", "http://a.test/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, "\t"));
// A disposable self-signed certificate for the loopback fake provider; no key fixture or real credentials.
execFileSync(
	"openssl",
	[
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-subj",
		"/CN=openrouter.ai",
		"-keyout",
		join(dir, "key.pem"),
		"-out",
		join(dir, "cert.pem"),
	],
	{ stdio: "ignore" },
);
let passed = 0;
const check = (name, ok, detail = "") => {
	if (ok) passed++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`}`,
	);
	if (!ok) process.exitCode = 1;
};
// The model follows `script`: each request takes the next step, `{calls: [[name, args], ...], text?}` or a function of
// the results so far that returns one; then it answers `final`. It records each tool result and the tools offered.
let script = [];
let final = "Done.";
const results = [];
/** The newest user message of each request, as the model got it. */
const asked = [];
let offered = [];
let callIds = 0;
const provider = createServer(
	{ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
	(req, res) => {
		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-headers", "*");
		if (req.method === "OPTIONS") return res.end();
		if (!(req.method === "POST" && req.url.endsWith("/chat/completions"))) {
			res.writeHead(404, { "content-type": "application/json" });
			return res.end('{"error":{"message":"not found"}}');
		}
		let body = "";
		req.on("data", (data) => {
			body += data;
		});
		req.on("end", () => {
			const request = JSON.parse(body);
			const { messages } = request;
			offered = (request.tools ?? []).map((tool) => tool.function.name);
			const user = messages.findLast((message) => message.role === "user");
			if (user !== undefined)
				asked.push(
					typeof user.content === "string" ? user.content : user.content.map((part) => part.text ?? "").join(""),
				);
			const names = new Map(
				messages.flatMap((message) => (message.tool_calls ?? []).map((call) => [call.id, call.function.name])),
			);
			const lastAnswer = messages.findLastIndex((message) => message.role === "assistant");
			for (const message of messages.slice(lastAnswer + 1)) {
				if (message.role !== "tool") continue;
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map((part) => part.text ?? "").join("");
				results.push({ name: names.get(message.tool_call_id), text });
			}
			let step = script.shift();
			if (typeof step === "function") {
				try {
					step = step(results);
				} catch (error) {
					console.log("STEP FAILED", error.message, JSON.stringify(results.slice(-2)).slice(0, 1500));
					process.exitCode = 1;
					step = undefined;
				}
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish) =>
				`data: ${JSON.stringify({ id: "gen", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			if (step === undefined) {
				res.write(chunk({ role: "assistant", content: final }, null));
				res.write(chunk({}, "stop"));
			} else {
				const tool_calls = step.calls.map(([name, args], index) => ({
					index,
					id: `call_${++callIds}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args ?? {}) },
				}));
				res.write(chunk({ role: "assistant", ...(step.text ? { content: step.text } : {}), tool_calls }, null));
				res.write(chunk({}, "tool_calls"));
			}
			res.end("data: [DONE]\n\n");
		});
	},
);
await new Promise((resolve) => provider.listen(8443, "127.0.0.1", resolve));

// What the page saw is kept in `window.seen`, which the test reads in the page's own world.
const FORM_PAGE = `<!doctype html><title>Form page</title>
<style>
body { font: 16px sans-serif; margin: 20px }
#cover { position: fixed; left: 0; top: 0; width: 300px; height: 60px; background: #eee; z-index: 1 }
#covered { margin-top: 0 }
</style>
<div id="cover" role="dialog" aria-label="Cookies">We use cookies.</div>
<button id="covered" style="position: fixed; left: 20px; top: 10px">Covered</button>
<main style="margin-top: 80px">
<h1>Form page</h1>
<button id="add">Add item</button>
<ul id="items"></ul>
<label>Name <input id="name" value="secret-value"></label>
<label>Password <input id="password" type="password"></label>
<div id="notes" contenteditable="true" aria-label="Notes" style="border: 1px solid #888; min-height: 20px"></div>
<label>Color <select id="color"><option>Red</option><option>Green</option><option>Blue</option></select></label>
<div id="open-host"></div>
<div id="closed-host"></div>
<a href="/second">Second page</a>
</main>
<script>
window.seen = [];
window.pageSecret = 42;
document.getElementById("add").addEventListener("click", () => {
	document.getElementById("items").append(Object.assign(document.createElement("li"), { textContent: "item" }));
	seen.push("add");
});
document.getElementById("name").addEventListener("input", (event) => seen.push("input:" + event.target.value));
document.getElementById("color").addEventListener("change", (event) => seen.push("change:" + event.target.value));
document.getElementById("covered").addEventListener("click", () => seen.push("covered"));
document.addEventListener("keydown", (event) => { if (event.key === "I" && event.shiftKey) seen.push("shift+I"); });
for (const [id, mode, label] of [["open-host", "open", "Shadow open"], ["closed-host", "closed", "Shadow closed"]]) {
	const root = document.getElementById(id).attachShadow({ mode });
	const button = Object.assign(document.createElement("button"), { textContent: label });
	button.addEventListener("click", () => seen.push(label));
	root.append(button);
}
</script>`;
// Busy changes the page for about 3 s, so pi's click on it waits to settle; the frame, on another site, opens a tab.
const FRAME_PAGE = `<!doctype html><title>Frame page</title>
<button id="busy">Busy</button>
<p id="log"></p>
<iframe id="frame" src="http://b.test:8701/inner" style="width: 300px; height: 80px"></iframe>
<script>
window.seen = [];
document.getElementById("busy").addEventListener("click", () => {
	seen.push("busy");
	let ticks = 0;
	const tick = setInterval(() => {
		document.getElementById("log").textContent = String(++ticks);
		if (ticks === 30) clearInterval(tick);
	}, 100);
});
</script>`;
// Images whose caption or name holds what the page does not draw, scripts, and fields.
const FIGURES_PAGE = `<!doctype html><title>Figures page</title>
<figure><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="hidden caption image" width="100" height="100"><figcaption hidden>CAPTION-HIDDEN-SECRET<script type="text/plain">CAPTION-SCRIPT-SECRET</script><textarea>CAPTION-TEXTAREA-SECRET</textarea></figcaption></figure>
<figure><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="drawn caption image" width="100" height="100"><figcaption>shown caption<span hidden>CAPTION-SPAN-SECRET</span><textarea>CAPTION-FIELD-SECRET</textarea><script type="text/plain">CAPTION-CODE-SECRET</script></figcaption></figure>
<span id="label" hidden>hidden label<script type="text/plain">LABEL-SCRIPT-SECRET</script><textarea>LABEL-FIELD-SECRET</textarea></span>
<div role="img" aria-labelledby="label" style="width: 60px; height: 60px; background: #888"></div>`;
// A muted video of 60 s of silence, made in the page, which plays at once; "Export complete" shows after 3 s, and a
// hidden "Hidden done" is there from the start.
const MEDIA_PAGE = `<!doctype html><title>Media page</title>
<video id="video" muted style="width: 320px; height: 180px"></video>
<p id="status">Exporting…</p>
<p hidden>Hidden done</p>
<script>
const rate = 8000, seconds = 60, data = new Uint8Array(44 + rate * seconds * 2);
const view = new DataView(data.buffer);
const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
text(0, "RIFF"); view.setUint32(4, data.length - 8, true); text(8, "WAVEfmt ");
view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, rate * seconds * 2, true);
const video = document.getElementById("video");
video.src = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
video.play();
setTimeout(() => { document.getElementById("status").textContent = "Export complete"; }, 3000);
</script>`;
const pages = createHttp((req, res) => {
	const path = req.url.split("?")[0];
	if (path === "/csp") {
		res.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'none'" });
		return res.end("<!doctype html><title>Strict page</title><p id='p'>No scripts here.</p>");
	}
	res.writeHead(200, { "content-type": "text/html" });
	if (path === "/second") return res.end("<!doctype html><title>Second page</title><p>The second page.</p>");
	if (path === "/frame") return res.end(FRAME_PAGE);
	if (path === "/figures") return res.end(FIGURES_PAGE);
	if (path === "/media") return res.end(MEDIA_PAGE);
	if (path === "/inner")
		return res.end(
			`<!doctype html><button id="open" onclick="window.open('${B}/second', '_blank')">Open a tab</button>`,
		);
	res.end(FORM_PAGE);
});
await new Promise((resolve) => pages.listen(8701, "127.0.0.1", resolve));
const A = "http://a.test:8701";
const B = "http://b.test:8701";

async function poll(test, what, timeout = 10_000) {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await test();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(100);
	}
}
const parse = (raw) => {
	try {
		return JSON.parse(raw);
	} catch {
		return { error: raw };
	}
};
/** The ref on the outline's line for the element named `label`. */
const refOf = (outline, label) => {
	const line = outline.split("\n").find((each) => each.includes(`"${label}"`)) ?? "";
	return [...line.matchAll(/\b([a-z]+\d+)\b/g)].at(-1)?.[1];
};

let context;
try {
	context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		ignoreHTTPSErrors: true,
		viewport: null,
		args: [
			"--headless=new",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP openrouter.ai 127.0.0.1:8443, MAP a.test 127.0.0.1:8701, MAP b.test 127.0.0.1:8701, MAP * ~NOTFOUND",
			"--no-proxy-server",
			"--ignore-certificate-errors",
			"--window-size=1280,900",
		],
	});
	const worker =
		context.serviceWorkers().find((w) => w.url().endsWith("/background.js")) ??
		(await context.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/background.js") }));
	const id = new URL(worker.url()).host;
	console.log(`chrome ${context.browser().version()}`);

	const web = context.pages()[0] ?? (await context.newPage());
	await web.goto(`${A}/form`);
	const tab = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, web.url());
	const panelUrl = `chrome-extension://${id}/panel.html?tab=${tab}`;
	// In a window of its own: the web page stays in front of its window.
	await worker.evaluate((url) => chrome.windows.create({ url, width: 380, height: 760 }), panelUrl);
	const panel = await poll(async () => context.pages().find((page) => page.url() === panelUrl), "panel window");
	const problems = [];
	panel.on("pageerror", (error) => problems.push(error.message));
	await panel.waitForSelector("#setup:not([hidden])");
	await panel.fill("#setup-key .key-field input", "sk-or-e2e-fake");
	await panel.click("#setup-key button.primary");
	await panel.waitForSelector("#setup", { state: "hidden" });

	/** pi attaches the tab's page, as after "Ask pi" in its context menu. */
	const attach = async () => {
		await worker.evaluate(async (url) => {
			const [tab] = await chrome.tabs.query({ url });
			await globalThis.__piTest.begin("context-menu", tab, { frameId: 0, url: tab.url, top: tab.url }).resolved;
		}, web.url());
		await panel.waitForFunction(
			(title) => document.getElementById("page-text").textContent === title,
			await web.title(),
		);
	};
	let turns = 0;
	/** Sends `text` with these model steps; `during` runs while the answer goes on. Returns the results of the turn. */
	async function turn(text, steps, during) {
		script = [...steps];
		final = `Done ${++turns}.`;
		const before = results.length;
		await panel.fill("#composer", text);
		await panel.press("#composer", "Enter");
		await during?.();
		await panel.waitForFunction(
			(done) => [...document.querySelectorAll(".msg.assistant .md")].some((node) => node.textContent.includes(done)),
			final,
			{ timeout: 45_000 },
		);
		return results.slice(before);
	}
	const call = (name, args) => ({ calls: [[name, args]] });
	/** Observes with `find`, then calls `name` with the ref of the line named `label` and `args`. */
	const onRef = (find, label, name, args) => [
		call("observe_page", { find }),
		(seen) => {
			const ref = refOf(parse(seen.at(-1).text).outline ?? "", label);
			if (ref === undefined) throw new Error(`no ref for ${label}: ${seen.at(-1).text}`);
			return call(name, { ...args, ref });
		},
	];
	const seen = () => web.evaluate(() => window.seen.slice());
	/** Answers the Ask card on the panel with the button named `name`. */
	const answerCard = (name) => async () => {
		const card = panel.locator(".ask");
		await card.waitFor({ timeout: 20_000 });
		await card.getByRole("button", { name, exact: true }).click();
	};
	const setMode = async (tool, mode) => {
		await panel.click("#open-settings");
		await panel.locator("label", { has: panel.locator(`input[name="tool-${tool}"][value="${mode}"]`) }).click();
		await poll(
			() =>
				worker.evaluate(
					async ([tool, mode]) => (await chrome.storage.local.get("settings")).settings?.tools?.[tool] === mode,
					[tool, mode],
				),
			`${tool} saved as ${mode}`,
		);
		await panel.click("#close-settings");
	};

	await attach();

	// Observing.
	let got = await turn("What is here?", [call("observe_page", {})]);
	const outline = parse(got[0]?.text).outline ?? "";
	check(
		"observe_page and act_on_page are offered, run_script not while Chrome's switch is off",
		offered.includes("observe_page") && offered.includes("act_on_page") && !offered.includes("run_script"),
		offered,
	);
	check(
		"the outline lists the heading, the buttons, and the fields",
		/heading "Form page" a\d+ level=1/.test(outline) &&
			refOf(outline, "Add item") !== undefined &&
			refOf(outline, "Name") !== undefined &&
			refOf(outline, "Color") !== undefined,
		outline,
	);
	check(
		"buttons in open and closed shadow roots are listed",
		refOf(outline, "Shadow open") !== undefined && refOf(outline, "Shadow closed") !== undefined,
	);
	check(
		"fields show their state, never their content",
		/"Name" a\d+ \(filled\)/.test(outline) &&
			/"Password" a\d+ \(empty\) password/.test(outline) &&
			!outline.includes("secret-value"),
		outline,
	);
	got = await turn("Find it", [call("observe_page", { find: "add button" })]);
	const found = parse(got[0]?.text).outline ?? "";
	check(
		"find keeps only the matches and their listed ancestors",
		found.includes('"Add item"') && !found.includes('"Shadow open"') && !found.includes('"Name"'),
		found,
	);

	// Ask: the first action on the origin in an answer shows a card.
	got = await turn("Add one", onRef("add", "Add item", "act_on_page", { action: "click" }), answerCard("Deny"));
	check(
		"Deny refuses the action, and the page sees nothing",
		/denied/i.test(got.at(-1)?.text ?? "") && (await seen()).length === 0,
		got.at(-1),
	);
	got = await turn("Add one", onRef("add", "Add item", "act_on_page", { action: "click" }), answerCard("Allow"));
	check(
		"Allow lets it act: the click reaches the page",
		parse(got.at(-1)?.text).done !== undefined && (await seen()).join() === "add",
		got.at(-1),
	);

	// The rest without cards.
	await setMode("act", "on");
	got = await turn("Shadow", onRef("shadow", "Shadow closed", "act_on_page", { action: "click" }));
	check("a click reaches a button in a closed shadow root", (await seen()).includes("Shadow closed"), got.at(-1));
	got = await turn("Type", onRef("name", "Name", "act_on_page", { action: "type", text: "Ada" }));
	check(
		"type replaces a field's text, and the page sees the input",
		(await web.inputValue("#name")) === "Ada" && (await seen()).includes("input:Ada"),
		got.at(-1),
	);
	got = await turn("Notes", onRef("notes", "Notes", "act_on_page", { action: "type", text: "Hello notes" }));
	check("type into a contenteditable", (await web.textContent("#notes")) === "Hello notes", got.at(-1));
	got = await turn("Password", onRef("password", "Password", "act_on_page", { action: "type", text: "hunter2" }));
	check(
		"type into a password field is refused, and nothing is typed",
		/password/i.test(got.at(-1)?.text ?? "") && (await web.inputValue("#password")) === "",
		got.at(-1),
	);
	got = await turn("Color", onRef("color", "Color", "act_on_page", { action: "select_option", option: "Green" }));
	check(
		"select_option chooses the option, and the page sees the change",
		(await web.inputValue("#color")) === "Green" && (await seen()).includes("change:Green"),
		got.at(-1),
	);
	got = await turn("Key", [call("act_on_page", { action: "press", key: "Shift+I" })]);
	check("press sends a key with its modifier", (await seen()).includes("shift+I"), got.at(-1));
	got = await turn("Covered", onRef("covered", "Covered", "act_on_page", { action: "click" }));
	check(
		"a click on a covered button is refused, naming what covers it",
		/covered by dialog "Cookies"/.test(got.at(-1)?.text ?? "") && !(await seen()).includes("covered"),
		got.at(-1),
	);

	// The user clicks in a frame while pi's click waits to settle, and that opens a tab: the user's, not pi's (design
	// 6.29). The frame's input never reaches the page's listeners; focus moving into the frame does.
	await web.goto(`${A}/frame`);
	await attach();
	got = await turn("Busy", onRef("busy", "Busy", "act_on_page", { action: "click" }), async () => {
		await poll(() => web.evaluate(() => window.seen.includes("busy")), "pi's click on Busy");
		await web.frameLocator("#frame").locator("#open").click();
	});
	const framed = parse(got.at(-1)?.text);
	check(
		"a tab the user opens from a frame while pi acts is not followed as pi's",
		/opened from the page while the user also used it, which pi does not use/.test(framed.done ?? "") &&
			framed.tab === undefined,
		got.at(-1),
	);
	for (const page of context.pages()) if (page.url() === `${B}/second`) await page.close();

	// Images: a caption only as drawn, a name from a hidden label without its scripts or fields.
	await web.goto(`${A}/figures`);
	await attach();
	got = await turn("Images", [call("observe_page", { find: "image" })]);
	const images = parse(got[0]?.text).outline ?? "";
	check(
		"observe_page leaves out a hidden caption, and a caption's or label's hidden text, scripts, and fields",
		/image "hidden caption image" \w+ 100×100$/m.test(images) &&
			/image "drawn caption image" \w+ 100×100 caption "shown caption"$/m.test(images) &&
			/image "hidden label" \w+ 60×60$/m.test(images) &&
			!/(CAPTION|LABEL)-\w+-SECRET/.test(images),
		images,
	);
	await web.goto(`${A}/form`);
	await attach();

	// Navigation, and a ref of the page before it.
	let oldRef;
	got = await turn("Go", [
		call("observe_page", { find: "add" }),
		(seen) => {
			oldRef = refOf(parse(seen.at(-1).text).outline ?? "", "Add item");
			return call("act_on_page", { action: "navigate", url: `${A}/second` });
		},
		() => call("act_on_page", { action: "click", ref: oldRef }),
	]);
	const moved = parse(got[1]?.text);
	check(
		"navigate on the page's origin moves the tab",
		web.url() === `${A}/second` && moved.navigated === true && moved.title === "Second page",
		got[1],
	);
	check(
		"a ref of the page before is gone",
		got[2]?.text === `${oldRef} is gone (the page changed): observe again`,
		got[2],
	);
	got = await turn("Elsewhere", [call("act_on_page", { action: "navigate", url: `${B}/form` })]);
	check(
		"navigate to another origin is refused",
		web.url() === `${A}/second` && got.at(-1)?.text === `navigate only goes to URLs on ${A}, not ${B}.`,
		got.at(-1),
	);

	// The user's own move to a site pi may not script (design 6.28): a link names the site on the card, the address
	// bar does not.
	await web.goto(`${A}/form`);
	await attach();
	await web.evaluate((url) => {
		document.body.append(Object.assign(document.createElement("a"), { id: "away", href: url, textContent: "Away" }));
	}, `${B}/second`);
	await Promise.all([web.waitForURL(`${B}/second`), web.click("#away")]);
	let siteCard;
	got = await turn("Read it", [call("observe_page", {})], async () => {
		const card = panel.locator(".ask");
		await card.waitFor({ timeout: 20_000 });
		siteCard = { text: await card.textContent(), buttons: await card.getByRole("button").allTextContents() };
		await card.getByRole("button", { name: "Cancel", exact: true }).click();
	});
	check(
		"a link the user followed to another site: the card names it",
		siteCard?.text.includes("pi needs http://b.test to continue.") &&
			siteCard.buttons.join() === "On all sites,On http://b.test,Cancel" &&
			/The user cancelled/.test(got.at(-1)?.text ?? ""),
		{ siteCard, result: got.at(-1) },
	);
	const movedLine = async () => panel.locator(".msg.user").last().locator(".source").nth(1).textContent();
	check(
		"the message about A says the tab moved, last seen going to b.test: to the model, and under the message",
		asked
			.at(-1)
			?.endsWith(
				`[Attached page: "Form page" (${A}/form); the tab has since moved to a page pi cannot read; it was last seen going to ${B}]`,
			) && (await movedLine()) === `Tab moved; last seen going to ${B}`,
		{ asked: asked.at(-1), line: await movedLine() },
	);
	await web.goto(`${A}/form`);
	await attach();
	await web.goto(`${B}/second`);
	got = await turn("Read it", [call("observe_page", {})], async () => {
		const card = panel.locator(".ask");
		await card.waitFor({ timeout: 20_000 });
		siteCard = { text: await card.textContent(), buttons: await card.getByRole("button").allTextContents() };
		await card.getByRole("button", { name: "Cancel", exact: true }).click();
	});
	check(
		"the address bar: the card names no site, and says how to allow this one alone",
		siteCard?.text.includes("pi needs the site this tab moved to.") &&
			siteCard.text.includes("click pi's toolbar button on this tab") &&
			siteCard.buttons.join() === "On all sites,Cancel",
		{ siteCard, result: got.at(-1) },
	);
	check(
		"the address bar: the message says the tab moved, to a site pi does not know",
		asked.at(-1)?.endsWith(`(${A}/form); the tab has since moved to a page pi cannot read]`) &&
			(await movedLine()) === "Tab moved to another site",
		{ asked: asked.at(-1), line: await movedLine() },
	);
	// On a page pi may read: the message names it.
	await web.goto(`${A}/form`);
	await attach();
	await web.goto(`${A}/second`);
	got = await turn("Read it", [call("observe_page", {})]);
	check(
		"a page on the same site: the message names the page the tab shows",
		asked.at(-1)?.endsWith(`(${A}/form); the tab now shows "Second page" (${A}/second)]`) &&
			(await movedLine())?.includes("Tab moved to") &&
			(await movedLine())?.includes("Second page"),
		{ asked: asked.at(-1), line: await movedLine() },
	);
	await attach();
	got = await turn("Read it", [call("observe_page", {})]);
	check(
		"a tab still on the attached page: no note",
		asked.at(-1)?.endsWith(`[Attached page: "Second page" (${A}/second)]`) &&
			(await panel.locator(".msg.user").last().locator(".source").count()) === 1,
		asked.at(-1),
	);
	// In the same document: a fragment that names an element is a place in the page; one that names none, such as an
	// app's route, is another page.
	await web.goto(`${A}/form`);
	await attach();
	await web.evaluate(() => {
		location.hash = "name";
	});
	got = await turn("Read it", [call("observe_page", {})]);
	check(
		"a section of the attached page: no note",
		asked.at(-1)?.endsWith(`[Attached page: "Form page" (${A}/form)]`),
		asked.at(-1),
	);
	await web.evaluate(() => {
		location.hash = "/route/b";
	});
	got = await turn("Read it", [call("observe_page", {})]);
	check(
		"a route in the same document: the message names it",
		asked.at(-1)?.endsWith(`(${A}/form); the tab now shows "Form page" (${A}/form#/route/b)]`),
		asked.at(-1),
	);

	// run_script.
	await web.goto(`${A}/form`);
	await attach();
	got = await turn("Script", [call("observe_page", {})]);
	check("run_script is still not offered", !offered.includes("run_script"), offered);
	await panel.click("#open-settings");
	check(
		"Settings says run_script needs Chrome's switch",
		(await panel.textContent("#user-scripts")).includes("Allow User Scripts"),
		await panel.textContent("#user-scripts"),
	);
	await panel.click("#close-settings");

	// The user turns on Allow User Scripts on pi's details page.
	const details = await context.newPage();
	await details.goto(`chrome://extensions/?id=${id}`);
	const toggle = details.locator("#allow-user-scripts");
	await toggle.waitFor();
	await toggle.click();
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
	await web.bringToFront();

	const run = (code) => call("run_script", { code, summary: "Check the page" });
	got = await turn("Title", [run("document.title")], async () => {
		const card = panel.locator(".ask");
		await card.waitFor({ timeout: 20_000 });
		check(
			"the script card shows the code with Run and Deny",
			(await card.locator("pre").textContent()) === "document.title" &&
				(await card.getByRole("button", { name: "Run", exact: true }).count()) === 1,
		);
		await card.getByRole("button", { name: "Run", exact: true }).click();
	});
	check("with the switch on, run_script is offered in Ask", offered.includes("run_script"), offered);
	let value = parse(got.at(-1)?.text);
	check(
		"Run runs it: a lone expression returns its value",
		value.ok === true && value.value === "Form page",
		got.at(-1),
	);
	got = await turn("Deny", [run("window.seen.push('script'); return 1;")], answerCard("Deny"));
	check("Deny runs nothing", /denied/i.test(got.at(-1)?.text ?? "") && !(await seen()).includes("script"), got.at(-1));

	// Stop on the card: the note before the call ends the turn, and its time and tools show without reopening the chat
	// (design 6.21), though its entry is already in the panel.
	script = [{ text: "Checking the page first.", calls: [["run_script", { code: "1", summary: "Check" }]] }];
	await panel.fill("#composer", "Stop on the card");
	await panel.press("#composer", "Enter");
	await panel.locator(".ask").waitFor({ timeout: 20_000 });
	const note = panel.locator(".msg.step-note", { hasText: "Checking the page first." });
	const before = await note.locator(".answer-stats, .usage-hint").count();
	await panel.locator("#stop").click();
	await poll(
		async () => (await panel.locator("#stop").isHidden()) && (await panel.locator(".ask").count()) === 0,
		"stopped",
	);
	const line = note.locator(".answer-stats");
	await poll(async () => (await line.count()) === 1, "the stopped turn's line", 5_000).catch(() => {});
	const stopped = (await line.count()) === 1 ? await line.textContent() : "";
	check(
		"Stop on a card: the step that ends the turn shows its time and tools in the open panel",
		before === 0 && /^\d[\d.]*(ms|s)\b/.test(stopped) && (await line.getAttribute("title")).includes("run_script ×1"),
		{ before, stopped, title: (await line.count()) === 1 ? await line.getAttribute("title") : null },
	);

	await setMode("script", "on");
	got = await turn("Body", [
		run(
			"console.log('counting'); await new Promise((done) => setTimeout(done, 50)); return document.querySelectorAll('button').length;",
		),
	]);
	value = parse(got.at(-1)?.text);
	check(
		"a body with await returns its value, with its logs",
		value.ok === true && value.value === 2 && JSON.stringify(value.logs).includes("counting"),
		got.at(-1),
	);
	got = await turn("World", [run("globalThis.kept = 7; return typeof window.pageSecret"), run("kept")]);
	check("pi's world sees the DOM, not the page's objects", parse(got[0]?.text).value === "undefined", got[0]);
	check("pi's world keeps its globals between scripts", parse(got[1]?.text).value === 7, got[1]);
	got = await turn("Throw", [run("throw new Error('broken on purpose')")]);
	value = parse(got.at(-1)?.text);
	check(
		"a throw comes back as an error with its message",
		value.ok === false && value.error?.message === "broken on purpose",
		got.at(-1),
	);

	await web.goto(`${A}/csp`);
	await attach();
	got = await turn("Strict", [run("document.getElementById('p').textContent")]);
	value = parse(got.at(-1)?.text);
	check(
		"a script runs on a page whose CSP allows no script",
		value.ok === true && value.value === "No scripts here.",
		got.at(-1),
	);

	await setMode("script", "off");
	got = await turn("Off", [call("observe_page", {})]);
	check("Off: run_script is not offered", !offered.includes("run_script"), offered);

	// wait_on_page (design 6.40): it follows Read page, so it is offered with Run script Off.
	await web.goto(`${A}/media`);
	await attach();
	const waitOn = (args) => call("wait_on_page", args);
	got = await turn("Wait for 0:02", [waitOn({ until: { media: { from: 0, to: 2 } }, timeoutSec: 30 })]);
	value = parse(got.at(-1)?.text);
	check(
		"wait_on_page is offered with Run script Off, and returns once the playing video passes the range",
		offered.includes("wait_on_page") && value.met === true && value.reason === "after" && value.position >= 2,
		got.at(-1),
	);
	got = await turn("Wait for the export", [waitOn({ until: { text: "export complete" }, timeoutSec: 30 })]);
	value = parse(got.at(-1)?.text);
	check(
		"a wait for a text returns once the page shows it",
		value.met === true && value.reason === "present",
		got.at(-1),
	);
	got = await turn("Wait for hidden", [waitOn({ until: { text: "hidden done" }, timeoutSec: 5 })]);
	value = parse(got.at(-1)?.text);
	check(
		"hidden text never counts: the wait times out, and a timeout is not an error",
		value.met === false && value.reason === "timeout" && value.waitedSec >= 5,
		got.at(-1),
	);
	got = await turn(
		"Wait, then reload",
		[waitOn({ until: { media: { from: 0, to: 55 } }, timeoutSec: 60 })],
		async () => {
			await sleep(2_000);
			await web.reload();
		},
	);
	check(
		"a reload ends the wait with an error that the page changed",
		(got.at(-1)?.text ?? "").startsWith("The page changed during the wait"),
		got.at(-1),
	);

	// Chrome stops the worker during a wait: the open panel starts the next one, which runs the wait again, for the same
	// video and until the same deadline, so waitedSec counts from the first run.
	await attach();
	const position = await web.evaluate(() => document.getElementById("video").currentTime);
	const to = Math.ceil(position) + 8;
	const cdp = await context.newCDPSession(panel);
	const startedAt = Date.now();
	let closed = false;
	got = await turn(
		"Wait across a restart",
		[waitOn({ until: { media: { from: 0, to } }, timeoutSec: 60 })],
		async () => {
			await sleep(3_000);
			const target = (await cdp.send("Target.getTargets")).targetInfos.find(
				(item) => item.type === "service_worker" && item.url === worker.url(),
			);
			closed = target !== undefined && (await cdp.send("Target.closeTarget", { targetId: target.targetId })).success;
		},
	);
	value = parse(got.at(-1)?.text);
	check(
		"a wait cut off by the worker's stop waits again for its first run's video and deadline",
		closed && value.met === true && value.reason === "after" && value.position >= to && value.waitedSec >= 7,
		{ closed, result: got.at(-1), to, tookSec: (Date.now() - startedAt) / 1000 },
	);
	check("no panel errors", problems.length === 0, problems);
	console.log(`${passed} checks passed.`);
} finally {
	await context?.close();
	await new Promise((resolve) => provider.close(resolve));
	await new Promise((resolve) => pages.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
