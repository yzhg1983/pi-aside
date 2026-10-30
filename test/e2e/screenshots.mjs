// screenshot_page end to end (design 6.26): a scripted fake model calls screenshot_page, and the run checks the
// results, the images the provider got, and their pixels. Without a grant; after a toolbar click (Chrome 147, CDP
// Extensions.triggerAction); a same-origin navigation; another origin; a background tab; crops in view, below the fold,
// in a scrolled list, and cut by the view; 150% zoom; pinch zoom; a noisy page; the quota; the tab watch across a
// navigation away and back from the back/forward cache; Settings. No request leaves the machine.
import assert from "node:assert/strict";
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

if (!process.env.CHROME) throw new Error("Set CHROME to a Chrome for Testing 147+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-screenshots-"));
const label = "147";
const ext = join(dir, "ext");
const profiles = [];
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
	// Test-only hooks in the temporary worker bundle, not in production source.
	footer: { js: "globalThis.__piTest = { begin, watchTab, tabChangeCount };" },
});
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts", diagnostics: "src/diagnostics/diagnostics.ts" } });
cpSync(join(repo, "static"), ext, { recursive: true });
// Existing English-label checks use the native English fallback; localization.mjs tests both full catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
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
const check = (name, ok, detail = "") => {
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === "" ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 2000)}`}`,
	);
	if (!ok) process.exitCode = 1;
};
// The model follows `script`: each request takes the next step, `{calls: [[name, args], ...]}` or a function of the
// results so far that returns one; then it answers `final`. It records each tool result, the tools offered, and the
// images of each request.
let script = [];
let final = "Done.";
const results = [];
let offered = [];
let requestImages = [];
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
			requestImages = messages.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter((part) => part.type === "image_url").map((part) => part.image_url.url)
					: [],
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
				res.write(chunk({ role: "assistant", tool_calls }, null));
				res.write(chunk({}, "tool_calls"));
			}
			res.end("data: [DONE]\n\n");
		});
	},
);
await new Promise((resolve) => provider.listen(8443, "127.0.0.1", resolve));

const BOX_PAGE = (title) => `<!doctype html><title>${title}</title>
<style>
body { margin: 0; font: 16px sans-serif; background: white }
.box { position: absolute }
#red { left: 200px; top: 150px; width: 300px; height: 120px; background: rgb(255, 0, 0) }
#blue { left: 200px; top: 1800px; width: 300px; height: 120px; background: rgb(0, 0, 255) }
#green { left: 600px; top: calc(100vh - 40px); width: 200px; height: 100px; background: rgb(0, 160, 0) }
#list { left: 600px; top: 150px; width: 300px; height: 200px; overflow: auto; border: 1px solid #888 }
#list div { height: 60px }
#deep { background: rgb(255, 200, 0) }
</style>
<h1>${title}</h1><a id="next" href="/next">next</a>
<div id="red" class="box" role="img" aria-label="Red box"></div>
<div id="blue" class="box" role="img" aria-label="Blue box"></div>
<div id="green" class="box" role="img" aria-label="Green box"></div>
<div id="list" class="box"><div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div id="deep" role="img" aria-label="Deep item">6</div></div>
<div style="height: 2400px"></div>
<script>addEventListener("pageshow", (event) => { window.lastShow = event.persisted; });</script>`;
const NOISE_PAGE = `<!doctype html><title>Noise</title><style>body{margin:0}</style><canvas id="c"></canvas>
<script>
const canvas = document.getElementById("c");
canvas.width = innerWidth; canvas.height = innerHeight;
const drawing = canvas.getContext("2d");
const image = drawing.createImageData(canvas.width, canvas.height);
for (let i = 0; i < image.data.length; i++) image.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
drawing.putImageData(image, 0, 0);
</script>`;
// Clips (code review round 1): borders, scrollbars, the body's own overflow, fixed and absolute boxes that escape an
// ancestor's clip, a rotated clip, a long role.
const CLIP_PAGE = `<!doctype html><title>Clip page</title>
<style>
body { margin: 0; font: 14px sans-serif }
.at { position: absolute }
.red { background: rgb(255, 0, 0) }
#bordered { left: 20px; top: 20px; width: 200px; height: 60px; border: 20px solid rgb(0, 0, 255); overflow: hidden }
#bordered .past { margin-left: 205px; width: 10px; height: 20px }
#bordered .inside { width: 50px; height: 20px }
#scroller { left: 300px; top: 20px; width: 200px; height: 100px; overflow: scroll }
#scroller .under { margin-left: 190px; width: 10px; height: 20px }
#trap { left: 20px; top: 200px; width: 80px; height: 80px; overflow: hidden }
#trap .fixed { position: fixed; left: 400px; top: 200px; width: 100px; height: 60px }
#trap2 { left: 20px; top: 320px; width: 80px; height: 80px; overflow: hidden; transform: translateX(0) }
#trap2 .fixed { position: fixed; left: 400px; top: 0; width: 100px; height: 60px }
#wrap { left: 20px; top: 440px; width: 300px; height: 80px }
#trap3 { width: 80px; height: 80px; overflow: hidden }
#trap3 .abs { position: absolute; left: 150px; top: 10px; width: 60px; height: 40px }
#turned { left: 600px; top: 200px; width: 120px; height: 120px; overflow: hidden; transform: rotate(30deg) }
#turned .child { width: 40px; height: 40px }
#spun { left: 600px; top: 420px; width: 60px; height: 30px; transform: rotate(45deg) }
#long { left: 20px; top: 600px; width: 100px; height: 30px }
#mirror { left: 140px; top: 600px; width: 200px; height: 60px; overflow: scroll; transform: scaleX(-1) }
#mirror .under { margin-left: 190px; width: 10px; height: 20px }
.box80 { width: 80px; height: 80px; top: 600px }
.clip { overflow: hidden }
.escape { position: fixed; left: 760px; width: 60px; height: 40px }
.held { position: fixed; left: 0; top: 100px; width: 60px; height: 40px }
#query { left: 360px; container-type: inline-size }
#trap4 { left: 460px }
#layout { left: 560px; contain: layout }
#trap5 { left: 660px }
#painted { left: 760px; contain: paint }
#painted .past { margin-top: 90px; width: 40px; height: 20px }
#svg-wrap { left: 20px; top: 690px }
#svg-border { left: 160px; top: 690px }
#svg-pad { left: 440px; top: 690px }
#svg-nested { left: 600px; top: 690px }
#cv { left: 560px; top: 20px; content-visibility: auto }
</style>
<div id="bordered" class="at"><div class="past red" role="img" aria-label="Bordered past"></div><div class="inside red" role="img" aria-label="Bordered inside"></div></div>
<div id="scroller" class="at"><div class="under red" role="img" aria-label="Scrollbar hidden"></div></div>
<div id="trap" class="at"><div class="fixed red" role="img" aria-label="Fixed escaping"></div></div>
<div id="trap2" class="at"><div class="fixed red" role="img" aria-label="Fixed trapped"></div></div>
<div id="wrap" class="at"><div id="trap3"><div class="abs red" role="img" aria-label="Absolute escaping"></div></div></div>
<div id="turned" class="at"><div class="child red" role="img" aria-label="Rotated inside"></div></div>
<div id="spun" class="at red" role="img" aria-label="Spun alone"></div>
<div id="long" class="at red" role="img" aria-label="Long role"></div>
<div id="mirror" class="at"><div class="under red" role="img" aria-label="Mirrored hidden"></div></div>
<div id="query" class="at box80 clip"><div class="escape red" style="top: 20px" role="img" aria-label="Query escaping"></div></div>
<div id="trap4" class="at box80 clip"><span style="transform: translateX(0)"><span class="escape red" style="top: 80px" role="img" aria-label="Span escaping"></span></span></div>
<div id="layout" class="at box80 clip"><div class="held red" role="img" aria-label="Layout trapped"></div></div>
<div id="trap5" class="at box80 clip"><span style="display: inline-block; transform: translateX(0)"><span class="held red" role="img" aria-label="Block span trapped"></span></span></div>
<div id="painted" class="at box80"><div class="past red" role="img" aria-label="Paint outside"></div></div>
<div id="svg-wrap" class="at"><svg width="100" height="80" style="overflow: hidden"><foreignObject x="200" y="0" width="100" height="40"><div role="img" aria-label="Svg outside" style="width: 100px; height: 40px; background: rgb(255, 0, 0)"></div></foreignObject></svg></div>
<div id="svg-border" class="at"><svg style="display: inline; vertical-align: top; width: 200px; height: 60px; border: 20px solid rgb(0, 0, 255); overflow: hidden"><foreignObject x="205" y="0" width="10" height="20"><div class="red" role="img" aria-label="Svg border past" style="width: 10px; height: 20px"></div></foreignObject><foreignObject x="20" y="10" width="40" height="20"><div class="red" role="img" aria-label="Svg border inside" style="width: 40px; height: 20px"></div></foreignObject></svg></div>
<div id="svg-pad" class="at"><svg style="display: inline; vertical-align: top; width: 100px; height: 60px; padding: 10px; overflow: hidden"><foreignObject x="102" y="0" width="6" height="20"><div class="red" role="img" aria-label="Svg padding past" style="width: 6px; height: 20px"></div></foreignObject></svg></div>
<div id="cv" class="at box80" style="top: 20px"><div class="past red" role="img" aria-label="Cv past" style="margin-top: 90px; width: 40px; height: 20px"></div><div class="held red" role="img" aria-label="Cv held"></div></div>
<div id="svg-nested" class="at"><svg width="100" height="60"><svg width="50" height="30"><foreignObject x="0" y="0" width="40" height="20"><div class="red" role="img" aria-label="Svg nested" style="width: 40px; height: 20px"></div></foreignObject></svg></svg></div>`;
// The root and the body (code review round 3): paint containment clips them although their overflow is the view's.
const EDGE_PAGE = (doctype, html, body) => `${doctype ? "<!doctype html>" : ""}<title>Edge page</title>
<style>html { ${html} } body { margin: 0; ${body} } .t { position: absolute; left: 100px; width: 50px; height: 20px; background: rgb(255, 0, 0) }</style>
<div class="t" role="img" aria-label="Edge past" style="top: 120px"></div><div class="t" role="img" aria-label="Edge inside" style="top: 20px"></div>`;
const EDGE_PAGES = {
	"/root-paint": EDGE_PAGE(true, "width: 300px; height: 100px; contain: paint", ""),
	"/root-short": EDGE_PAGE(true, "width: 300px; height: 100px", ""),
	"/body-paint": EDGE_PAGE(true, "", "position: relative; width: 300px; height: 100px; contain: paint"),
	"/quirks-paint": EDGE_PAGE(
		false,
		"",
		"position: relative; width: 300px; height: 100px; border: 5px solid rgb(0, 0, 255); contain: paint",
	),
	"/quirks-scroll": EDGE_PAGE(false, "overflow: hidden", "position: relative; height: 100px; overflow: auto"),
};
const BODY_PAGE = (html, body = "") => `<!doctype html><title>Body page</title>
<style>html { ${html} } body { margin: 0; height: 100px; overflow: hidden; ${body} }</style>
<div style="height: 120px"></div><div role="img" aria-label="Body target" style="width: 100px; height: 20px; background: rgb(255, 0, 0)"></div>`;
// A diagram taller than the view, in a figure that does not scroll (the tester's case), and a tall item in a short list.
// Red top band, green middle, blue bottom band.
const TALL_PAGE = `<!doctype html><title>Tall page</title>
<style>
body { margin: 0; font: 16px sans-serif }
.bands { background: linear-gradient(rgb(255, 0, 0) 0 60px, rgb(0, 160, 0) 60px calc(100% - 60px), rgb(0, 0, 255) calc(100% - 60px)) }
#diagram { width: 400px; height: 1333px; margin-left: 40px }
#list { width: 300px; height: 300px; overflow: auto; border: 1px solid #888; margin: 40px }
#list .filler { height: 400px }
#item { width: 250px; height: 500px }
</style>
<p style="height: 600px">Text above.</p>
<figure><div id="diagram" class="bands" role="img" aria-label="Tall diagram"></div></figure>
<div id="list"><div class="filler"></div><div id="item" class="bands" role="img" aria-label="Tall item"></div><div class="filler"></div></div>
<div style="height: 1200px"></div>`;
// Tall elements review round 1 (pi): a scroll box taller than the view, a tall element that scrolls itself, a list
// drawn at half its size.
const TALL_STYLE = `<style>body { margin: 0; font: 16px sans-serif }
.bands { background: linear-gradient(rgb(255, 0, 0) 0 60px, rgb(0, 160, 0) 60px calc(100% - 60px), rgb(0, 0, 255) calc(100% - 60px)) }</style>`;
const TALL_PAGES = {
	"/tall-box": `<!doctype html><title>Tall box</title>${TALL_STYLE}
<div style="height: 1200px; width: 400px; overflow: auto"><div class="bands" role="img" aria-label="Box target" style="height: 3000px; width: 300px"></div></div>
<div style="height: 400px"></div>`,
	"/tall-self": `<!doctype html><title>Tall self</title>${TALL_STYLE}
<p style="height: 300px">Text above.</p>
<div role="img" aria-label="Self target" style="height: 1000px; width: 300px; overflow: auto"><div class="bands" style="height: 3000px"></div></div>
<div style="height: 1500px"></div>`,
	// Tall elements review round 2: a 600 px list inside a 300 px list.
	"/tall-nested": `<!doctype html><title>Tall nested</title>${TALL_STYLE}
<div style="height: 300px; width: 420px; overflow: auto"><div style="height: 600px; width: 400px; overflow: auto">
<div class="bands" role="img" aria-label="Nested target" style="height: 1800px; width: 300px"></div></div></div>
<div style="height: 1500px"></div>`,
	"/tall-nested-center": `<!doctype html><title>Tall nested center</title>${TALL_STYLE}
<div style="height: 300px; width: 420px; overflow: auto"><div style="height: 600px; width: 400px; overflow: auto">
<div style="height: 700px"></div><div class="bands" role="img" aria-label="Centered target" style="height: 500px; width: 300px"></div><div style="height: 200px"></div></div></div>
<div style="height: 1500px"></div>`,
	// Tall elements review round 3: a body that clips because of containment, a boxless wrapper, paint containment.
	"/tall-body": `<!doctype html><title>Tall body</title>${TALL_STYLE}
<style>body { height: 300px; overflow: auto; contain: layout }</style>
<div style="height: 600px; width: 400px; overflow: auto"><div class="bands" role="img" aria-label="Body target" style="height: 1800px; width: 300px"></div></div>`,
	"/tall-contents": `<!doctype html><title>Tall contents</title>${TALL_STYLE}
<div style="height: 300px; width: 420px; overflow: auto"><div style="display: contents; overflow: hidden"><div style="height: 600px; width: 400px; overflow: auto">
<div class="bands" role="img" aria-label="Contents target" style="height: 1800px; width: 300px"></div></div></div></div>
<div style="height: 1500px"></div>`,
	"/tall-paint": `<!doctype html><title>Tall paint</title>${TALL_STYLE}
<div style="height: 300px; width: 420px; contain: paint"><div style="height: 600px; width: 400px; overflow: auto">
<div class="bands" role="img" aria-label="Paint target" style="height: 1800px; width: 300px"></div></div></div>
<div style="height: 1500px"></div>`,
	// Tall elements review round 4 (P3): the root scrolls the page.
	"/tall-root": `<!doctype html><title>Tall root</title>${TALL_STYLE}
<style>html { overflow-y: scroll }</style>
<p style="height: 600px">Text above.</p>
<div class="bands" role="img" aria-label="Root target" style="height: 3000px; width: 300px"></div>`,
	"/tall-scaled": `<!doctype html><title>Tall scaled</title>${TALL_STYLE}
<div style="height: 900px"></div>
<div style="height: 300px; width: 400px; overflow: auto; transform: scale(0.5); transform-origin: 0 0">
<div style="height: 400px"></div><div class="bands" role="img" aria-label="Scaled item" style="height: 500px; width: 300px"></div><div style="height: 400px"></div></div>
<div style="height: 1500px"></div>`,
};
const pagesServer = createHttp((req, res) => {
	const path = req.url.split("?")[0];
	res.writeHead(200, { "content-type": "text/html" });
	if (path === "/noise") return res.end(NOISE_PAGE);
	if (path === "/tall") return res.end(TALL_PAGE);
	if (TALL_PAGES[path] !== undefined) return res.end(TALL_PAGES[path]);
	if (path === "/clip") return res.end(CLIP_PAGE);
	if (path === "/body-clip") return res.end(BODY_PAGE("overflow: auto"));
	if (path === "/body-view") return res.end(BODY_PAGE(""));
	// Code review round 4: containment on the root or the body keeps the body's overflow its own.
	if (path === "/body-root-layout") return res.end(BODY_PAGE("contain: layout"));
	if (path === "/body-root-paint") return res.end(BODY_PAGE("height: 200px; contain: paint"));
	if (path === "/body-type") return res.end(BODY_PAGE("", "container-type: inline-size"));
	if (path === "/body-cv") return res.end(BODY_PAGE("", "content-visibility: auto"));
	if (path === "/body-transform") return res.end(BODY_PAGE("transform: translateX(0)"));
	if (EDGE_PAGES[path] !== undefined) return res.end(EDGE_PAGES[path]);
	if (path === "/other") return res.end("<!doctype html><title>Other</title><p>Other page</p>");
	res.end(BOX_PAGE(path === "/next" ? "Next page" : "Box page"));
});
await new Promise((resolve) => pagesServer.listen(8601, "127.0.0.1", resolve));
const A = "http://a.test:8601";
const B = "http://b.test:8601";

async function launch(allSites = false) {
	const profile = mkdtempSync(join(dir, "profile-"));
	profiles.push(profile);
	const manifest = JSON.parse(readFileSync(join(repo, "static/manifest.json"), "utf8"));
	// Only the second, fresh profile receives all-sites access. The original refusal tests stay narrow.
	manifest.host_permissions = ["https://openrouter.ai/*", "http://a.test/*", ...(allSites ? ["<all_urls>"] : [])];
	writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, "\t"));
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: process.env.CHROME,
		headless: false,
		ignoreHTTPSErrors: true,
		viewport: null,
		// The back/forward cache, and scrollbars as a user sees them.
		ignoreDefaultArgs: ["--disable-back-forward-cache", "--hide-scrollbars"],
		args: [
			"--headless=new",

			"--enable-unsafe-extension-debugging",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=MAP openrouter.ai 127.0.0.1:8443, MAP a.test 127.0.0.1:8601, MAP b.test 127.0.0.1:8601, MAP * ~NOTFOUND",
			"--no-proxy-server",
			"--ignore-certificate-errors",
			"--window-size=1280,900",
		],
	});
	try {
		const find = () => context.serviceWorkers().find((w) => w.url().endsWith("/background.js"));
		const worker =
			find() ??
			(await context.waitForEvent("serviceworker", { predicate: (w) => w.url().endsWith("/background.js") }));
		await poll(
			() =>
				worker
					.evaluate(async () => {
						const { browserSession } = await chrome.storage.session.get("browserSession");
						return typeof browserSession === "string" && browserSession.length > 0;
					})
					.catch(() => false),
			"worker ready",
		);
		assert.equal(await worker.evaluate(() => chrome.i18n.getMessage("localeCode")), "en");
		return { context, worker, id: new URL(worker.url()).host };
	} catch (error) {
		await context.close();
		throw error;
	}
}

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

const NO_GRANT =
	"Chrome lets pi capture this tab only with access to all sites, or after the user opens pi on it while it shows this site. Ask the user to allow pi on all sites in Settings > Advanced > Sites, or to click pi's toolbar button on this tab, then try again.";
const NOT_IN_FRONT =
	"The tab is not in front, so pi cannot capture it: Chrome captures only the tab shown in its window.";
/** pi found the element not wholly in view, so it scrolled it into view first; what came after varies. */
const OUT_OF_VIEW = "(scrolled into view first)";
const scrolledThen = (text, expected) =>
	expected === OUT_OF_VIEW ? /^Scrolled .+ into view\. /.test(text) : text === expected;
const ROTATED =
	"The element is in a rotated, skewed, or mirrored part of the page; pi can only capture the whole view.";
const UNMEASURED = "pi cannot measure where the page cuts this element off; pi can only capture the whole view.";
/** The ref on the outline's line for the element named `label`. */
const refOf = (outline, label) => {
	const line = outline.split("\n").find((each) => each.toLowerCase().includes(`"${label.toLowerCase()}"`)) ?? "";
	return [...line.matchAll(/\b([a-z]+\d+)\b/g)].at(-1)?.[1];
};

let run;
try {
	run = await launch();
	const { context, worker, id } = run;
	const version = context.browser().version();
	console.log(`chrome ${version}`);
	assert(Number.parseInt(version, 10) >= 147, "Chrome 147+ is required for toolbar-click checks.");
	assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ["<all_urls>"] })), false);

	const tabOf = (page) => worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url());
	const attach = async (page, panel) => {
		await worker.evaluate(async (url) => {
			const [tab] = await chrome.tabs.query({ url });
			await globalThis.__piTest.begin("context-menu", tab, { frameId: 0, url: tab.url, top: tab.url }).resolved;
		}, page.url());
		await panel.waitForFunction(
			(title) => document.getElementById("page-text").textContent === title,
			await page.title(),
		);
	};
	const cdp = await context.browser().newBrowserCDPSession();
	/** The user clicks pi's toolbar button on `page`: Chrome grants activeTab, and pi attaches the page. */
	const click = async (page, panel) => {
		await page.bringToFront();
		const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{}] });
		const target = targetInfos.find((info) => info.type === "tab" && info.url === page.url());
		await cdp.send("Extensions.triggerAction", { id, targetId: target.targetId });
		await panel.waitForFunction(
			(title) => document.getElementById("page-text").textContent === title,
			await page.title(),
		);
	};
	let turns = 0;
	/** Sends `text` with these model steps; `during` runs while the answer goes on. Returns the results of the turn. */
	async function turn(panel, text, steps, during) {
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
	const shot = (args = {}) => ({ calls: [["screenshot_page", args]] });
	/** Observes with `find`, then takes a screenshot of the first match. */
	const shotOf = (find) => [
		{ calls: [["observe_page", { find }]] },
		(seen) => {
			const outline = parse(seen.at(-1).text).outline ?? "";
			const ref = refOf(outline, find);
			if (ref === undefined) throw new Error(`no ref for ${find}: ${outline}`);
			return shot({ ref });
		},
	];
	const stored = () => worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
	/** The colour at (`x`, `y`) of the newest image the provider got, in its pixels, and the image's size. */
	const pixel = (x, y) =>
		worker.evaluate(
			async ([url, x, y]) => {
				const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0));
				const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const drawing = canvas.getContext("2d");
				drawing.drawImage(bitmap, 0, 0);
				const [r, g, b] = drawing.getImageData(Math.round(x), Math.round(y), 1, 1).data;
				return { r, g, b, width: bitmap.width, height: bitmap.height };
			},
			[requestImages.at(-1), x, y],
		);
	const red = (color) => color != null && color.r > 200 && color.g < 60 && color.b < 60;
	const saveImage = (name) => {
		const url = requestImages.at(-1);
		if (url !== undefined)
			writeFileSync(join(dir, `shot-${name}-${label}.jpg`), Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
	};

	const web = context.pages()[0] ?? (await context.newPage());
	await web.goto(`${A}/box`);
	const tab = await tabOf(web);
	const view = await web.evaluate(() => ({
		innerWidth,
		innerHeight,
		clientWidth: document.documentElement.clientWidth,
	}));
	console.log("view", JSON.stringify(view));
	// In a window of its own: the web page stays in front of its window.
	const panelUrl = `chrome-extension://${id}/panel.html?tab=${tab}`;
	await worker.evaluate((url) => chrome.windows.create({ url, width: 380, height: 760 }), panelUrl);
	const panel = await poll(async () => context.pages().find((page) => page.url() === panelUrl), "panel window");
	const placement = await worker.evaluate(async (tabId) => {
		const tabs = await chrome.tabs.query({});
		return tabs.map((each) => ({
			id: each.id,
			windowId: each.windowId,
			active: each.active,
			url: each.url,
			mine: each.id === tabId,
		}));
	}, tab);
	console.log("tabs", JSON.stringify(placement));
	await panel.waitForSelector("#setup:not([hidden])");
	await panel.fill("#setup-key .key-field input", "sk-or-e2e-fake");
	await panel.click("#setup-key button.primary");
	await panel.waitForSelector("#setup", { state: "hidden" });
	await attach(web, panel);

	// Settings: On by default, with its note.
	await panel.click("#open-settings");
	await panel.locator("#tool-screenshot-note").scrollIntoViewIfNeeded();
	check(
		"Settings: Screenshot page is On by default",
		(await panel.isChecked('input[name="tool-screenshot"][value="on"]')) &&
			(await stored())?.tools?.screenshot !== "off",
	);
	check(
		"Settings: the note says what the image shows and when it works",
		(await panel.textContent("#tool-screenshot-note")).includes(
			"also what you typed into fields, and goes to the model's provider",
		),
	);
	await panel.screenshot({ path: join(dir, `shot-settings-${label}.png`) });
	await panel.click("#close-settings");

	// No grant: the page was attached from the menu, which the test calls without a gesture.
	let got = await turn(panel, "Look", [shot()]);
	check("screenshot_page is offered", offered.includes("screenshot_page"), offered);
	check("without a grant, the call says to click the toolbar button", got[0]?.text === NO_GRANT, got);
	check("no image was sent", requestImages.length === 0, requestImages.length);
	got = await turn(panel, "Down", [shot({ scroll: "down" })]);
	const scrolledY = await web.evaluate(() => scrollY);
	check(
		"scroll down without a grant: the page scrolls, and the refusal says so",
		got[0]?.text === `Scrolled the page down. ${NO_GRANT}` && Math.abs(scrolledY - 0.8 * view.innerHeight) <= 1,
		{ got, scrolledY },
	);
	got = await turn(panel, "Top", [shot({ scroll: "top" })]);
	check(
		"scroll top says it is at the top",
		got[0]?.text === `Scrolled the page top (at the top). ${NO_GRANT}` && (await web.evaluate(() => scrollY)) === 0,
		got,
	);

	// Where an element can show (code review round 1). Without a grant, an element that can show gets as far as the
	// capture; one that cannot is refused before it.
	const clipText = async (label) => (await turn(panel, label, shotOf(label))).at(-1)?.text ?? "";
	for (const [label, expected, why] of [
		["Bordered past", OUT_OF_VIEW, "an element under its scroller's border is not in view"],
		["Bordered inside", NO_GRANT, "an element inside its scroller's border can show"],
		["Scrollbar hidden", OUT_OF_VIEW, "an element under its scroller's scrollbar is not in view"],
		["Fixed escaping", NO_GRANT, "a fixed element outside an ancestor that clips can show"],
		["Fixed trapped", OUT_OF_VIEW, "a fixed element placed by a transformed ancestor is clipped by it"],
		["Absolute escaping", NO_GRANT, "an absolute element placed by an ancestor above the clip can show"],
		["Rotated inside", ROTATED, "an element in a rotated clip is refused"],
		["Spun alone", NO_GRANT, "a rotated element with no clip around it can show"],
		// Round 2.
		["Mirrored hidden", ROTATED, "an element in a mirrored clip is refused"],
		["Query escaping", NO_GRANT, "a size container does not hold a fixed element"],
		["Span escaping", NO_GRANT, "a transform on an inline span does not hold a fixed element"],
		["Layout trapped", OUT_OF_VIEW, "layout containment holds a fixed element, and its overflow clips it"],
		["Block span trapped", OUT_OF_VIEW, "a transform on an inline-block span holds a fixed element"],
		["Paint outside", OUT_OF_VIEW, "paint containment clips with its overflow visible"],
		["Svg outside", OUT_OF_VIEW, "an inline svg clips at its viewport"],
		// Round 3.
		["Svg border past", OUT_OF_VIEW, "an element under an svg's border is not in view"],
		["Svg border inside", NO_GRANT, "an element inside a bordered svg can show"],
		["Svg padding past", OUT_OF_VIEW, "an svg clips at its content box, inside its padding"],
		["Svg nested", UNMEASURED, "an element in an inner svg's clip is refused"],
		// Round 4.
		["Cv past", OUT_OF_VIEW, "content-visibility: auto clips like paint containment"],
		["Cv held", OUT_OF_VIEW, "content-visibility: auto holds a fixed element"],
	]) {
		await web.goto(`${A}/clip`);
		await attach(web, panel);
		const text = await clipText(label);
		check(`clip: ${why}`, scrolledThen(text, expected), text);
	}
	for (const [path, expected, why] of [
		["/body-clip", OUT_OF_VIEW, "the body clips on its own when the root has an overflow"],
		["/body-view", NO_GRANT, "the body's overflow is the view's when the root's is visible"],
		// Round 4.
		["/body-root-layout", OUT_OF_VIEW, "layout containment on the root keeps the body's overflow its own"],
		["/body-root-paint", OUT_OF_VIEW, "a body clip inside a taller painted root"],
		["/body-type", OUT_OF_VIEW, "a container-type on the body keeps its overflow its own"],
		["/body-cv", OUT_OF_VIEW, "content-visibility on the body keeps its overflow its own"],
		["/body-transform", NO_GRANT, "a transform on the root does not keep the body's overflow"],
	]) {
		await web.goto(`${A}${path}`);
		await attach(web, panel);
		const text = await clipText("Body target");
		check(`clip: ${why}`, scrolledThen(text, expected), text);
	}
	for (const [path, label, expected, why] of [
		["/root-paint", "Edge past", OUT_OF_VIEW, "paint containment on the root clips it"],
		["/root-paint", "Edge inside", NO_GRANT, "an element inside the painted root can show"],
		["/root-short", "Edge past", NO_GRANT, "a short root without paint containment does not clip"],
		[
			"/body-paint",
			"Edge past",
			OUT_OF_VIEW,
			"paint containment on the body clips it while its overflow is the view's",
		],
		["/quirks-paint", "Edge past", OUT_OF_VIEW, "paint containment on a quirks-mode body clips it"],
		["/quirks-paint", "Edge inside", NO_GRANT, "an element inside a painted quirks-mode body can show"],
		["/quirks-scroll", "Edge inside", UNMEASURED, "a quirks-mode body that scrolls on its own is refused"],
	]) {
		await web.goto(`${A}${path}`);
		await attach(web, panel);
		const text = await clipText(label);
		check(`clip: ${why} (${path})`, scrolledThen(text, expected), text);
	}
	await web.goto(`${A}/box`);
	await attach(web, panel);

	// A background tab: another tab in front of the window.
	const otherTab = await worker.evaluate(
		async ([url, windowId]) => (await chrome.tabs.create({ url, active: true, windowId })).id,
		[`${B}/other`, await worker.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).windowId, tab)],
	);
	got = await turn(panel, "Look", [shot()]);
	check("a tab behind another one is not captured", got[0]?.text === NOT_IN_FRONT, got);
	await worker.evaluate(async (tabId) => chrome.tabs.remove(tabId), otherTab);
	await worker.evaluate(async (tabId) => chrome.tabs.update(tabId, { active: true }), tab);

	// The tab watch counts a navigation away and back from the back/forward cache, whose document keeps its ID.
	const documentOf = () =>
		worker.evaluate(
			async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: () => 1 }))[0].documentId,
			tab,
		);
	const before = await documentOf();
	await worker.evaluate((tabId) => {
		globalThis.stopWatch = globalThis.__piTest.watchTab(tabId);
		globalThis.countBefore = globalThis.__piTest.tabChangeCount();
	}, tab);
	await web.click("#next");
	await web.waitForURL(`${A}/next`);
	// A page restored from the cache fires no load event.
	await web.goBack({ waitUntil: "commit" });
	await poll(
		async () =>
			web.url() === `${A}/box` && (await web.evaluate(() => window.lastShow).catch(() => undefined)) !== undefined,
		"page shown again",
	);
	const restored = await web.evaluate(() => window.lastShow);
	const counted = await worker.evaluate(() => {
		globalThis.stopWatch();
		return globalThis.__piTest.tabChangeCount() - globalThis.countBefore;
	});
	const after = await documentOf();
	check(
		"Chrome restored the page from the back/forward cache with its document ID",
		restored === true && after === before,
		{ restored, before, after },
	);
	check("the tab watch counted the navigation away and back", counted >= 2, counted);
	await worker.evaluate(() => {
		globalThis.countBefore = globalThis.__piTest.tabChangeCount();
	});
	// While a capture of the page runs, a tab in the background navigates.
	const navigated = await worker.evaluate(
		async ([tabId, url]) => {
			const stop = globalThis.__piTest.watchTab(tabId);
			const before = globalThis.__piTest.tabChangeCount();
			const loaded = (id) =>
				new Promise((resolve) => {
					const listener = (updated, change) => {
						if (updated === id && change.status === "complete") {
							chrome.tabs.onUpdated.removeListener(listener);
							resolve();
						}
					};
					chrome.tabs.onUpdated.addListener(listener);
				});
			const { id } = await chrome.tabs.create({ url, active: false });
			await loaded(id);
			await Promise.all([loaded(id), chrome.tabs.update(id, { url: `${url}?2` })]);
			await chrome.tabs.remove(id);
			stop();
			return globalThis.__piTest.tabChangeCount() - before;
		},
		[tab, `${B}/other`],
	);
	check("another tab's navigations do not count", navigated === 0, navigated);

	await click(web, panel);
	// The click opens Chrome's side panel, which narrows the page.
	await poll(async () => (await web.evaluate(() => innerWidth)) < view.innerWidth - 100, "side panel open");
	await sleep(300);
	const grantedView = await web.evaluate(() => ({
		innerWidth,
		innerHeight,
		clientHeight: document.documentElement.clientHeight,
	}));
	console.log("view after the click", JSON.stringify(grantedView));
	got = await turn(panel, "Look", [shot()]);
	let result = parse(got[0]?.text ?? "");
	const scale = result.width / grantedView.innerWidth;
	check(
		"after a toolbar click, the visible part of the tab comes back as an image and JSON",
		result.url === `${A}/box` && result.clipped === false && result.width > 0 && requestImages.length === 1,
		{ result, images: requestImages.length },
	);
	check(
		"the image is a JPEG",
		requestImages[0]?.startsWith("data:image/jpeg;base64,"),
		requestImages[0]?.slice(0, 40),
	);
	let color = await pixel(350 * scale, 210 * scale);
	check("the image shows the red box where the page has it", red(color), color);
	saveImage("view");
	const notices = await panel.locator(".msg.notice").allTextContents();
	check(
		"the chat shows the line and the size",
		notices.some(
			(notice) => notice.includes("Took a screenshot") && notice.includes(`${result.width} × ${result.height}`),
		),
		notices,
	);
	check("the chat line shows the image", (await panel.locator(".msg.notice img").count()) === 1);

	got = await turn(panel, "Red", shotOf("red box"));
	result = parse(got.at(-1)?.text ?? "");
	check(
		"a crop of the red box: its padded size, not clipped, its role and name",
		result.width === 316 &&
			result.height === 136 &&
			result.clipped === false &&
			result.role === "image" &&
			result.name === "Red box",
		result,
	);
	color = await pixel(158, 68);
	const edge = await pixel(2, 2);
	check("the crop shows the box, with white padding", red(color) && edge.r > 200 && edge.g > 200 && edge.b > 200, {
		color,
		edge,
	});
	saveImage("red");
	const lines = await panel.locator(".msg.notice").allTextContents();
	check(
		"the chat names the element",
		lines.some((line) => /Took a screenshot of image "Red box" \([a-z]+\d+\)/.test(line)),
		lines,
	);

	const blue = (color) => color.b > 200 && color.r < 60 && color.g < 60;
	const yellow = (color) => color.r > 200 && color.g > 150 && color.b < 80;
	got = await turn(panel, "Blue", shotOf("blue box"));
	result = parse(got.at(-1)?.text ?? "");
	color = await pixel(result.width / 2, result.height / 2);
	check(
		"an element below the fold is scrolled into view and captured",
		/^Scrolled image "Blue box" \([a-z]+\d+\) into view$/.test(result.scrolled) &&
			result.clipped === false &&
			result.height === 136 &&
			blue(color),
		{ result, color },
	);
	saveImage("blue");
	const blueLines = await panel.locator(".msg.notice").allTextContents();
	check(
		"the chat line says what scrolled",
		blueLines.some((line) => line.includes("Took a screenshot of image") && line.includes("into view; 316 × 136")),
		blueLines.slice(-2),
	);
	got = await turn(panel, "Deep", shotOf("deep item"));
	result = parse(got.at(-1)?.text ?? "");
	color = await pixel(result.width / 2, result.height / 2);
	const deepTop = await web.evaluate(() => {
		const list = document.getElementById("list").getBoundingClientRect();
		const deep = document.getElementById("deep").getBoundingClientRect();
		return { list: list.top, deep: deep.top, bottom: list.bottom };
	});
	check(
		"an element below the visible part of a scrolled list: the list and the page scroll to it",
		/into view$/.test(result.scrolled) &&
			result.clipped === false &&
			yellow(color) &&
			deepTop.deep >= deepTop.list &&
			deepTop.deep + 60 <= deepTop.bottom,
		{ result, color, deepTop },
	);

	// ref and scroll: the ref's scrollable area. The list to its top hides the item; to its bottom shows it.
	const deepRef = refOf(parse(results.findLast((one) => one.name === "observe_page").text).outline ?? "", "deep item");
	got = await turn(panel, "List top", [shot({ ref: deepRef, scroll: "top" })]);
	check(
		"ref and scroll top: the list scrolls, and the element is then out of view",
		/^Scrolled .+ top \(at the top\)\. The element is not in view after the scroll; leave out scroll to scroll to the element\.$/.test(
			got[0]?.text ?? "",
		) && (await web.evaluate(() => document.getElementById("list").scrollTop)) === 0,
		got,
	);
	got = await turn(panel, "List bottom", [shot({ ref: deepRef, scroll: "bottom" })]);
	result = parse(got[0]?.text ?? "");
	color = await pixel(result.width / 2, result.height / 2);
	check(
		"ref and scroll bottom: the list's end, with the element in it",
		/^Scrolled .+ bottom \(at the bottom\)$/.test(result.scrolled) && yellow(color),
		{ result, color },
	);

	// The green box starts 40 px above the bottom of the window: at the top of the page it is cut by the view's end.
	got = await turn(panel, "Green", [
		{ calls: [["observe_page", { find: "green box" }]] },
		(seen) => shot({ ref: refOf(parse(seen.at(-1).text).outline ?? "", "green box"), scroll: "top" }),
	]);
	result = parse(got.at(-1)?.text ?? "");
	// A horizontal scrollbar can take some of the 40 px.
	const greenHeight = grantedView.clientHeight - (grantedView.innerHeight - 40) + 8;
	check(
		"an element cut by the bottom of the view, with the page scrolled to the top: its visible part, clipped",
		result.scrolled === "Scrolled the page top (at the top)" &&
			result.clipped === true &&
			result.height === greenHeight,
		{ result, greenHeight },
	);
	got = await turn(panel, "Green whole", shotOf("green box"));
	result = parse(got.at(-1)?.text ?? "");
	check(
		"the same element with ref alone: scrolled into view, not clipped",
		/into view$/.test(result.scrolled) && result.clipped === false && result.height === 116,
		result,
	);

	// The page: down moves the red box out of the image; top brings it back; bottom says so.
	await web.evaluate(() => scrollTo(0, 0));
	got = await turn(panel, "Page down", [shot({ scroll: "down" })]);
	result = parse(got[0]?.text ?? "");
	color = await pixel(350 * scale, 210 * scale);
	check(
		"scroll down: the view moved, the red box is gone from the image",
		result.scrolled === "Scrolled the page down" && !red(color) && (await web.evaluate(() => scrollY)) > 0,
		{ result, color },
	);
	got = await turn(panel, "Page top", [shot({ scroll: "top" })]);
	result = parse(got[0]?.text ?? "");
	color = await pixel(350 * scale, 210 * scale);
	check("scroll top: the red box is back", result.scrolled === "Scrolled the page top (at the top)" && red(color), {
		result,
		color,
	});
	got = await turn(panel, "Page bottom", [shot({ scroll: "bottom" })]);
	result = parse(got[0]?.text ?? "");
	check(
		"scroll bottom says it is at the bottom, and the page stays there",
		result.scrolled === "Scrolled the page bottom (at the bottom)" &&
			(await web.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 2)),
		result,
	);

	// With act_on_page Off, a screenshot still scrolls.
	await panel.click("#open-settings");
	await panel.click('label:has(> input[name="tool-act"][value="off"])');
	await poll(async () => (await stored())?.tools?.act === "off", "act off saved");
	await panel.click("#close-settings");
	got = await turn(panel, "Act off", [shot({ scroll: "top" })]);
	result = parse(got[0]?.text ?? "");
	check(
		"with act_on_page Off, screenshot_page scrolls",
		!offered.includes("act_on_page") && result.scrolled === "Scrolled the page top (at the top)" && result.width > 0,
		{ result, offered },
	);
	await panel.click("#open-settings");
	await panel.click('label:has(> input[name="tool-act"][value="ask"])');
	await poll(async () => (await stored())?.tools?.act === "ask", "act ask saved");
	await panel.click("#close-settings");

	// A same-origin navigation keeps the grant.
	await web.click("#next");
	await web.waitForURL(`${A}/next`);
	got = await turn(panel, "Next", [shot()]);
	result = parse(got[0]?.text ?? "");
	check("after a same-origin link, the capture still works, with the new URL", result.url === `${A}/next`, got);
	await web.goto(`${A}/box`);

	// 150% zoom: the image has device pixels.
	await worker.evaluate(async (tabId) => chrome.tabs.setZoom(tabId, 1.5), tab);
	await poll(async () => (await web.evaluate(() => devicePixelRatio)) === 1.5, "zoom 150%");
	got = await turn(panel, "Zoomed", shotOf("red box"));
	result = parse(got.at(-1)?.text ?? "");
	color = await pixel(result.width / 2, result.height / 2);
	check(
		"at 150% zoom, the crop maps onto the image's pixels",
		Math.abs(result.width - 474) <= 2 && Math.abs(result.height - 204) <= 2 && red(color),
		{ result, color },
	);
	saveImage("zoom");
	await worker.evaluate(async (tabId) => chrome.tabs.setZoom(tabId, 1), tab);
	await poll(async () => (await web.evaluate(() => devicePixelRatio)) === 1, "zoom 100%");

	// Pinch zoom: refused for a crop, the whole view still works.
	const page = await context.newCDPSession(web);
	await page.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
	await poll(async () => (await web.evaluate(() => visualViewport.scale)) === 2, "pinch 2");
	got = await turn(panel, "Pinch", [...shotOf("red box"), shot()]);
	check(
		"under a pinch zoom, a crop is refused and the whole view works",
		got[1]?.text === "The page is zoomed with a pinch; pi can only capture the whole view." &&
			parse(got[2]?.text ?? "").width > 0,
		got,
	);
	await page.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

	// A noisy page needs the smaller encodings.
	await web.goto(`${A}/noise`);
	await attach(web, panel);
	got = await turn(panel, "Noise", [shot()]);
	result = parse(got[0]?.text ?? "");
	const size = requestImages.at(-1)?.length ?? 0;
	console.log("noise:", JSON.stringify(result), "base64 chars", size);
	// The same view captured here and encoded at the first step: over the limit, so pi stepped down.
	await sleep(600);
	const atFirst = await worker.evaluate(async (tabId) => {
		const { windowId } = await chrome.tabs.get(tabId);
		const png = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
		const bitmap = await createImageBitmap(await (await fetch(png)).blob());
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
		return Math.ceil(blob.size / 3) * 4;
	}, tab);
	check(
		"a noisy view over 500 KB at the first encoding is sent smaller, within 500 KB",
		result.width > 0 && atFirst > 500_000 && size - "data:image/jpeg;base64,".length <= 500_000,
		{ result, size, atFirst },
	);
	saveImage("noise");
	await web.goto(`${A}/box`);
	await attach(web, panel);

	// The quota: captures from elsewhere in the worker use Chrome's 2 a second.
	got = await turn(panel, "Quota", [shot()], async () => {
		await worker.evaluate(async (tabId) => {
			const { windowId } = await chrome.tabs.get(tabId);
			const end = Date.now() + 4000;
			globalThis.quotaErrors = 0;
			void (async () => {
				while (Date.now() < end) {
					await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg" }).catch((error) => {
						if (String(error).includes("MAX_CAPTURE")) globalThis.quotaErrors += 1;
					});
					await new Promise((resolve) => setTimeout(resolve, 120));
				}
			})();
		}, tab);
	});
	const quota = got[0]?.text ?? "";
	console.log(
		"quota:",
		quota.slice(0, 200),
		"other captures refused:",
		await worker.evaluate(() => globalThis.quotaErrors),
	);
	check(
		"under the quota, a capture retries once, then works or says so",
		parse(quota).width > 0 || quota === "Chrome allows only 2 captures a second, and refused this one; try again.",
		quota,
	);
	await sleep(4500);

	// A new chat: the one so far sends 20 images, the most per request.
	await panel.click("#new-chat");
	await panel.waitForFunction(() => document.querySelectorAll(".msg").length === 0);
	// Elements that can show, with the grant: each crop shows the element.
	for (const label of [
		"Bordered inside",
		"Fixed escaping",
		"Absolute escaping",
		"Spun alone",
		"Query escaping",
		"Span escaping",
		"Svg border inside",
	]) {
		await web.goto(`${A}/clip`);
		await attach(web, panel);
		const text = (await turn(panel, label, shotOf(label))).at(-1)?.text ?? "";
		result = parse(text);
		color = result.width > 0 ? await pixel(result.width / 2, result.height / 2) : null;
		check(
			`clip with the grant: "${label}" is captured, not clipped`,
			result.scrolled === undefined && result.clipped === false && red(color),
			{ text, color },
		);
	}
	// Elements pi scrolled into view first: either still hidden, or the crop shows them.
	for (const label of [
		"Bordered past",
		"Scrollbar hidden",
		"Fixed trapped",
		"Layout trapped",
		"Block span trapped",
		"Paint outside",
		"Svg outside",
		"Svg border past",
		"Svg padding past",
		"Cv past",
		"Cv held",
	]) {
		await web.goto(`${A}/clip`);
		await attach(web, panel);
		const text = (await turn(panel, label, shotOf(label))).at(-1)?.text ?? "";
		result = parse(text);
		color = result.width > 0 ? await pixel(result.width / 2, result.height / 2) : null;
		console.log(
			`scrolled first: ${label}: ${result.width > 0 ? `captured ${result.width} × ${result.height}` : "still hidden"}`,
		);
		check(
			`clip with the grant, scrolled first: "${label}" is either still hidden, or its crop shows it`,
			/^Scrolled .+ into view\. The element is not in view, also after pi scrolled to it: something on the page hides it\.$/.test(
				text,
			) ||
				(/into view$/.test(result.scrolled) && red(color)),
			{ text: text.slice(0, 300), color },
		);
	}
	// A role of 60,000 characters set after the element was observed.
	await turn(panel, "Long", [{ calls: [["observe_page", { find: "Long role" }]] }]);
	const longRef = refOf(parse(results.at(-1).text).outline ?? "", "Long role");
	await web.evaluate(() => document.getElementById("long").setAttribute("role", "x".repeat(60_000)));
	got = await turn(panel, "Long shot", [shot({ ref: longRef })]);
	result = parse(got[0]?.text ?? "");
	const caption = (await panel.locator(".msg.notice").allTextContents()).at(-1) ?? "";
	check(
		"a long role comes back cut: the result is whole JSON, and the chat line is short",
		result.role?.length <= 80 && Buffer.byteLength(got[0].text) < 4096 && caption.length < 400,
		{ role: result.role?.length, bytes: Buffer.byteLength(got[0]?.text ?? ""), caption: caption.length },
	);
	// The same role on an element below the fold: pi scrolls to it, and the role in `scrolled` is cut too (scroll review 1).
	await web.evaluate(() => {
		document.getElementById("long").style.top = "4000px";
		document.body.style.height = "5000px";
		scrollTo(0, 0);
	});
	got = await turn(panel, "Long scroll", [shot({ ref: longRef })]);
	result = parse(got[0]?.text ?? "");
	check(
		"a long role on an element pi scrolls to: scrolled is short, and the result is whole JSON",
		/^Scrolled x{79}… "Long role" \([a-z]+\d+\) into view$/.test(result.scrolled ?? "") &&
			Buffer.byteLength(got[0].text) < 4096,
		{ scrolled: result.scrolled?.slice(0, 200), bytes: Buffer.byteLength(got[0]?.text ?? "") },
	);
	await web.goto(`${A}/body-view`);
	await attach(web, panel);
	result = parse((await turn(panel, "Body", shotOf("Body target"))).at(-1)?.text ?? "");
	color = await pixel(result.width / 2, result.height / 2);
	check("clip with the grant: the body's overflow is the view's", result.clipped === false && red(color), {
		result,
		color,
	});
	for (const [path, label] of [
		["/root-paint", "Edge inside"],
		["/quirks-paint", "Edge inside"],
		["/root-short", "Edge past"],
	]) {
		await web.goto(`${A}${path}`);
		await attach(web, panel);
		result = parse((await turn(panel, label, shotOf(label))).at(-1)?.text ?? "");
		color = await pixel(result.width / 2, result.height / 2);
		check(
			`clip with the grant: "${label}" on ${path} is captured, not clipped`,
			result.clipped === false && red(color),
			{ result, color },
		);
	}
	// An element taller than the view (scroll review: the tester's case). A new chat: the images so far are near 20.
	await panel.click("#new-chat");
	await panel.waitForFunction(() => document.querySelectorAll(".msg").length === 0);
	await web.goto(`${A}/tall`);
	await attach(web, panel);
	const viewHeight = await web.evaluate(() => document.documentElement.clientHeight);
	got = await turn(panel, "Tall", shotOf("Tall diagram"));
	result = parse(got.at(-1)?.text ?? "");
	color = await pixel(result.width / 2, 20);
	check(
		"a tall element with ref alone: scrolled to its top, shown from 0, its top band in the image",
		/into view$/.test(result.scrolled) &&
			result.clipped === true &&
			result.shown?.from === 0 &&
			result.shown?.to === viewHeight &&
			result.shown?.of === 1333 &&
			red(color),
		{ result, color, viewHeight },
	);
	saveImage("tall-top");
	const tallRef = refOf(
		parse(results.findLast((one) => one.name === "observe_page").text).outline ?? "",
		"Tall diagram",
	);
	const steps = [];
	for (let step = 0; step < 4 && result.shown?.to !== result.shown?.of; step++) {
		got = await turn(panel, `Tall ${step}`, [shot({ ref: tallRef, scroll: "down" })]);
		result = parse(got[0]?.text ?? "");
		steps.push(result.shown);
	}
	color = await pixel(result.width / 2, result.height - 20);
	const covered = steps.every(
		(rows, index) => rows !== undefined && rows.from <= (index === 0 ? viewHeight : steps[index - 1].to),
	);
	check(
		"then with ref and scroll down until shown.to equals shown.of: the bands overlap, and the last shows its bottom band",
		covered &&
			result.shown?.to === 1333 &&
			steps.length <= 2 &&
			/^Scrolled the page down/.test(result.scrolled) &&
			blue(color),
		{ steps, color },
	);
	saveImage("tall-bottom");
	await web.evaluate(() => scrollTo(0, 0));
	got = await turn(panel, "Tall item", shotOf("Tall item"));
	result = parse(got.at(-1)?.text ?? "");
	color = await pixel(result.width / 2, 20);
	check(
		"an item taller than its list: scrolled to its top in the list, shown from 0",
		/into view$/.test(result.scrolled) && result.shown?.from === 0 && result.shown?.to === 300 && red(color),
		{ result, color },
	);
	// Tall elements review round 1: each tall element is seen whole by ref, then ref and down until shown.to equals
	// shown.of, with no rows skipped between steps.
	/** Captures `label` with ref, then steps down; returns the first result, the steps, and the last result. */
	const stepThrough = async (label) => {
		await panel.click("#new-chat");
		await panel.waitForFunction(() => document.querySelectorAll(".msg").length === 0);
		const first = parse((await turn(panel, label, shotOf(label))).at(-1)?.text ?? "");
		const ref = refOf(parse(results.findLast((one) => one.name === "observe_page").text).outline ?? "", label);
		const steps = [];
		let last = first;
		for (let step = 0; step < 12 && last.shown !== undefined && last.shown.to !== last.shown.of; step++) {
			last = parse((await turn(panel, `${label} ${step}`, [shot({ ref, scroll: "down" })]))[0]?.text ?? "");
			steps.push({ shown: last.shown, scrolled: last.scrolled });
		}
		const rows = [first.shown, ...steps.map((one) => one.shown)];
		const gapless = rows.every((one, index) => one !== undefined && (index === 0 || one.from <= rows[index - 1].to));
		return { first, steps, last, gapless };
	};
	await web.goto(`${A}/tall-box`);
	await attach(web, panel);
	let walk = await stepThrough("Box target");
	color = await pixel(walk.last.width / 2, walk.last.height - 20);
	check(
		"a scroll box taller than the view: steps follow what shows, and the page moves when the box is at its end",
		walk.first.shown?.from === 0 &&
			walk.gapless &&
			walk.last.shown?.to === 3000 &&
			walk.steps.some((one) => one.scrolled.startsWith("Scrolled the page")) &&
			blue(color),
		{ first: walk.first.shown, steps: walk.steps, color },
	);
	await web.goto(`${A}/tall-self`);
	await attach(web, panel);
	walk = await stepThrough("Self target");
	color = await pixel(walk.last.width / 2, walk.last.height - 20);
	check(
		"a tall element that scrolls itself: its content moves first, then the page, until all of its box is shown",
		walk.first.shown?.from === 0 &&
			walk.first.shown?.of === 1000 &&
			walk.gapless &&
			walk.last.shown?.to === 1000 &&
			walk.steps.some((one) => /^Scrolled image "Self target" \([a-z]+\d+\) down/.test(one.scrolled)) &&
			/^Scrolled the page down/.test(walk.last.scrolled) &&
			blue(color),
		{ first: walk.first.shown, steps: walk.steps, color },
	);
	await web.goto(`${A}/tall-scaled`);
	await attach(web, panel);
	walk = await stepThrough("Scaled item");
	color = await pixel(walk.first.width / 2, 4);
	check(
		"an item taller than its list drawn at half size: compared as drawn, so it starts at its top",
		walk.first.shown?.from === 0 && walk.first.shown?.of === 250 && walk.gapless && walk.last.shown?.to === 250,
		{ first: walk.first, steps: walk.steps },
	);
	// Tall elements review round 2: the outer list cuts off the inner one, so steps follow the 300 px that show.
	await web.goto(`${A}/tall-nested`);
	await attach(web, panel);
	walk = await stepThrough("Nested target");
	check(
		"a list inside a shorter list: steps follow the part the outer list shows, with no rows skipped",
		walk.first.shown?.from === 0 && walk.first.shown?.to === 300 && walk.gapless && walk.last.shown?.to === 1800,
		{ first: walk.first.shown, steps: walk.steps },
	);
	await web.goto(`${A}/tall-nested-center`);
	await attach(web, panel);
	walk = await stepThrough("Centered target");
	check(
		"an element taller than the outer list but not the inner one starts at its top",
		walk.first.shown?.from === 0 && walk.gapless && walk.last.shown?.to === 500,
		{ first: walk.first.shown, steps: walk.steps },
	);
	// Tall elements review round 3: stepping cuts off what shows as the capture does.
	for (const [path, label, end] of [
		["/tall-body", "Body target", 1800],
		["/tall-contents", "Contents target", 1800],
		["/tall-paint", "Paint target", 1500],
	]) {
		await web.goto(`${A}${path}`);
		await attach(web, panel);
		walk = await stepThrough(label);
		// The paint-contained box does not scroll: its target's rows past 1,500 cannot show, and the page step that
		// follows moves it out of view.
		const rows = [walk.first.shown, ...walk.steps.map((one) => one.shown)].filter((one) => one !== undefined);
		const gapless = rows.every((one, index) => index === 0 || one.from <= rows[index - 1].to);
		check(
			`stepping follows the capture's clips (${path}): no rows skipped`,
			walk.first.shown?.from === 0 && walk.first.shown?.to === 300 && gapless && rows.at(-1).to === end,
			{ first: walk.first.shown, steps: walk.steps },
		);
	}
	// Tall elements review round 4: a root that scrolls is the page, stepped by most of a view.
	await web.goto(`${A}/tall-root`);
	await attach(web, panel);
	walk = await stepThrough("Root target");
	check(
		"a root with overflow-y: scroll steps the page by most of a view",
		walk.first.shown?.from === 0 &&
			walk.gapless &&
			walk.last.shown?.to === 3000 &&
			walk.steps.every((one) => one.scrolled.startsWith("Scrolled the page down")) &&
			walk.steps[0]?.shown.from >= 0.8 * walk.first.shown.to - 2,
		{ first: walk.first.shown, steps: walk.steps },
	);
	await web.goto(`${A}/box`);
	await attach(web, panel);

	// Another origin ends the grant, also back on the site.
	await web.goto(`${B}/other`);
	await web.goto(`${A}/box`);
	await attach(web, panel);
	got = await turn(panel, "Back", [shot()]);
	check("after another origin, the grant is gone", got[0]?.text === NO_GRANT, got);
	await panel.screenshot({ path: join(dir, `shot-${label}.png`) });

	// Off: not offered.
	await panel.click("#open-settings");
	await panel.click('label:has(> input[name="tool-screenshot"][value="off"])');
	await poll(async () => (await stored())?.tools?.screenshot === "off", "screenshot off saved");
	await panel.click("#close-settings");
	await turn(panel, "Tools?", []);
	check(
		"Off: screenshot_page is not offered",
		!offered.includes("screenshot_page") && offered.includes("observe_page"),
		offered,
	);

	// Separate fresh profile: all-sites capture must work without any toolbar click or inherited activeTab grant.
	await run.context.close();
	run = await launch(true);
	const wide = run;
	assert.equal(await wide.worker.evaluate(() => chrome.permissions.contains({ origins: ["<all_urls>"] })), true);
	const wideWeb = wide.context.pages()[0] ?? (await wide.context.newPage());
	await wideWeb.goto(`${A}/box`);
	const wideTab = await wide.worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, wideWeb.url());
	const widePanelUrl = `chrome-extension://${wide.id}/panel.html?tab=${wideTab}`;
	await wide.worker.evaluate((url) => chrome.windows.create({ url, width: 380, height: 760 }), widePanelUrl);
	const widePanel = await poll(
		() => wide.context.pages().find((page) => page.url() === widePanelUrl),
		"all-sites panel",
	);
	await widePanel.waitForSelector("#setup:not([hidden])");
	await widePanel.fill("#setup-key .key-field input", "sk-or-e2e-fake");
	await widePanel.click("#setup-key button.primary");
	await widePanel.waitForSelector("#setup", { state: "hidden" });
	await wide.worker.evaluate(async (url) => {
		const [tab] = await chrome.tabs.query({ url });
		await globalThis.__piTest.begin("context-menu", tab, { frameId: 0, url, top: url }).resolved;
	}, wideWeb.url());
	await widePanel.waitForFunction(() => document.getElementById("page-text").textContent === "Box page");
	const wideGot = await turn(widePanel, "All sites, no toolbar click", [shot()]);
	const wideResult = parse(wideGot[0]?.text ?? "");
	check(
		"all-sites access without a toolbar click captures an image",
		wideResult.url === `${A}/box` &&
			wideResult.width > 0 &&
			wideResult.height > 0 &&
			wideResult.clipped === false &&
			requestImages.length === 1 &&
			requestImages[0].startsWith("data:image/jpeg;base64,"),
		wideGot,
	);
} catch (error) {
	check("run", false, error.stack);
} finally {
	await run?.context.close();
	provider.close();
	pagesServer.close();
	for (const profile of profiles) rmSync(profile, { recursive: true, force: true });
}
