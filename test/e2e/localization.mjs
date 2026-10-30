// Native catalogs, production panel/prompts and faux inference. Disposable profiles/bundle, loopback only.
// macOS needs Cocoa's separate -AppleLanguages array argument; Playwright's locale is not Chrome's UI locale.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

if (!process.env.CHROME) throw Error("Set CHROME to a Chrome for Testing 147+ executable.");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-localization-")),
	ext = join(dir, "ext"),
	profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
assert.equal(manifest.default_locale, "en");
assert.deepEqual(readdirSync(join(ext, "_locales")).sort(), ["en", "zh_CN"]);
manifest.host_permissions = ["http://127.0.0.1/*", "https://openrouter.ai/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
const catalogs = Object.fromEntries(
	["en", "zh_CN"].map((code) => [
		code,
		JSON.parse(readFileSync(join(ext, "_locales", code, "messages.json"), "utf8")),
	]),
);
assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.zh_CN).sort());
const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { loadSettings, saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { buildMenus } from ${JSON.stringify(join(repo, "src/background/menus.ts"))};
import { interfaceLocale, t } from ${JSON.stringify(join(repo, "src/shared/i18n.ts"))};
import { userScriptsAllowed } from ${JSON.stringify(join(repo, "src/shared/user-scripts.ts"))};
import { PRESETS } from ${JSON.stringify(join(repo, "src/shared/presets.ts"))};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "locale-test" }], tokensPerSecond: 1000 });
models.setProvider(faux.provider);
const requests = [];
globalThis.__locale = { loadSettings, saveSettings, buildMenus, interfaceLocale, t, userScriptsAllowed, originals: PRESETS, requests,
  script(mode = "answer") {
    requests.length = 0;
    const record = transcript => requests.push(structuredClone(transcript));
    const reads = mode === "read" ? [{}, {}] : [];
    faux.setResponses([...reads.map(args => transcript => {
      record(transcript); return fauxAssistantMessage(fauxToolCall("read_page", args), { stopReason: "toolUse" });
    }), async transcript => {
      record(transcript);
      if (mode === "stop-error" || mode === "complete")
        await new Promise(resolve => globalThis.__locale.release = resolve);
      return mode === "error" || mode === "stop-error"
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: mode === "stop-error" ? t("answerStopped") : "RAW provider error / 原始错误" })
        : fauxAssistantMessage(mode === "abort" ? "Partial Stop regression. ".repeat(1000) : "Existing English answer / 已有内容");
    }]);
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
	banner: {
		js: 'globalThis.__unexpectedFetch = []; globalThis.fetch = async (...args) => { globalThis.__unexpectedFetch.push(String(args[0])); throw Error("Unexpected localization-test fetch: " + args[0]); };',
	},
};
await build({
	...common,
	entryPoints: [entry],
	outfile: join(ext, "background.js"),
	plugins: [
		{
			name: "test-only-hooks",
			setup(builder) {
				builder.onLoad({ filter: /\/background\/main\.ts$/ }, ({ path }) => ({
					contents: `${readFileSync(path, "utf8")}\nglobalThis.__localeMain = { begin, askSelection, askPage, run, schedule };`,
					loader: "ts",
					resolveDir: join(repo, "src/background"),
				}));
			},
		},
	],
});
await build({
	...common,
	entryPoints: { panel: "src/panel/panel.ts", "chatgpt-callback": "src/callback/chatgpt-callback.ts" },
	outdir: ext,
	footer: {
		js: "globalThis.__localeState = () => typeof state === 'undefined' ? undefined : state; globalThis.__localeCard = { node: askNode, client }; globalThis.__localeAnnounceChanges = announceChanges;",
	},
});
const site = createServer((_req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end(
		'<!doctype html><title>Locale fixture</title><p id="selection">Selected ORIGINAL 文本</p><p>Whole page fixture.</p>',
	);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;
let browser, context, worker, panel, page, tabId, code, originals;
let checks = 0;
const menuErrors = []; // Keep a menu comparison failure visible while checking the remaining native locales.
const rawError = "RAW provider error / 原始错误";
const check = (name, ok = true) => {
	assert(ok, name);
	console.log(`PASS ${name}`);
	checks++;
};
const equal = (name, actual, expected) => {
	assert.deepEqual(actual, expected, name);
	check(name);
};
async function poll(test, name) {
	const until = Date.now() + 20_000;
	while (Date.now() < until) {
		const result = await test();
		if (result) return result;
		await sleep(50);
	}
	throw Error(`Timed out: ${name}`);
}
const message = (key, values = []) =>
	catalogs[code === "zh-CN" ? "zh_CN" : "en"][key].message.replace(/\$\$|\$([1-9])/g, (_, n) =>
		n ? String(values[Number(n) - 1] ?? "") : "$",
	);
const state = () => panel.evaluate(() => globalThis.__localeState());
const stored = () => worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
const command = (cmd) =>
	worker.evaluate(
		async ({ cmd, tabId }) => {
			try {
				return await globalThis.__localeMain.run(cmd, tabId);
			} finally {
				globalThis.__localeMain.schedule();
			}
		},
		{ cmd, tabId },
	);
const settingsView = async (open) => {
	if ((await panel.locator("#settings").isVisible()) !== open)
		await panel.locator(open ? "#open-settings" : "#close-settings").click();
};
/**
 * Chrome's native catalog resolves every key the panel's HTML names to this locale's message. One check for all of
 * them, so a hook added later is covered without listing it; some hooks are only initial text the panel replaces, so
 * what is drawn is the sweep's to check.
 */
async function staticLabels() {
	const native = await panel.evaluate(() => {
		// Not fetch: the suite stubs it to catch network use.
		const request = new XMLHttpRequest();
		request.open("GET", "panel.html", false);
		request.send();
		const html = new DOMParser().parseFromString(request.responseText, "text/html");
		return [...html.querySelectorAll("*")].flatMap((el) =>
			[...el.attributes]
				.filter((attribute) => attribute.name.startsWith("data-i18n"))
				.map((attribute) => [attribute.value, chrome.i18n.getMessage(attribute.value)]),
		);
	});
	assert(native.length > 100, "the panel's HTML names its labels");
	equal(
		`${code}: Chrome's native catalog gives every key the panel's HTML names`,
		native.filter(([key, text]) => text !== message(key)),
		[],
	);
}
/**
 * The visible text and labels of what the panel shows now, outside user content: none is a raw message key, and none
 * is a message of the other catalog, as an English label left in the Chinese interface would be. One check per view,
 * so a label nobody listed is covered too. Messages with substitutions and those the catalogs share are not matched.
 */
async function sweep(where) {
	const other = catalogs[code === "zh-CN" ? "en" : "zh_CN"],
		own = catalogs[code === "zh-CN" ? "zh_CN" : "en"];
	const foreign = Object.entries(other).flatMap(([key, { message }]) =>
		message !== own[key].message && !/\$[1-9]/.test(message) ? [[message.replace(/\s+/g, " ").trim(), key]] : [],
	);
	const found = await panel.evaluate(
		({ foreign, keys }) => {
			const strange = new Map(foreign),
				raw = new Set(keys);
			// What the user, the model, or the page wrote: questions, answers, prompt names, chat titles, scripts.
			const content =
				".msg.user, .msg.assistant .md, .msg.live, .prompt-head .name, .history-row .title, #history-note, .ask pre, .ask > p:first-of-type, .attach, #model-chip, textarea, input, pre, code";
			const shown = (el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest(content);
			const problems = [];
			const look = (text, el, what) => {
				const value = text.replace(/\s+/g, " ").trim();
				const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${what}`;
				if (raw.has(value) || value.includes("__MSG_")) problems.push(`raw key "${value}" in ${name}`);
				else if (strange.has(value)) problems.push(`"${value}" (${strange.get(value)}) in ${name}`);
			};
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const el = walker.currentNode.parentElement;
				if (el && shown(el)) look(walker.currentNode.textContent, el, "");
			}
			for (const attribute of ["title", "aria-label", "placeholder", "alt"])
				for (const el of document.querySelectorAll(`[${attribute}]`))
					if (shown(el)) look(el.getAttribute(attribute), el, ` [${attribute}]`);
			return problems;
		},
		{ foreign, keys: Object.keys(own) },
	);
	equal(`${code}: ${where} has no raw or other-language labels`, found, []);
}
async function stop(verify = false) {
	try {
		if (verify) {
			equal(`${code}: worker made no network fetch`, await worker.evaluate(() => globalThis.__unexpectedFetch), []);
			equal(`${code}: panel made no network fetch`, await panel.evaluate(() => globalThis.__unexpectedFetch), []);
		}
	} finally {
		await context?.close();
		context = undefined;
	}
}
async function start(lang, expected, seed = false) {
	code = expected;
	let executablePath = process.env.CHROME;
	if (process.platform === "darwin") {
		// Playwright rejects the bare Cocoa array argument. An exec-only launcher preserves its normal Chrome flags.
		executablePath = join(dir, "chrome.sh");
		const apple = lang === "zh-CN" ? "zh-Hans" : lang === "zh-TW" ? "zh-Hant" : lang;
		writeFileSync(executablePath, `#!/bin/sh\nexec "$CHROME" -AppleLanguages '(${apple})' "$@"\n`, { mode: 0o700 });
	}
	context = await chromium.launchPersistentContext(profile, {
		executablePath,
		// Chrome on Linux takes its UI language from LANGUAGE and ignores --lang.
		env: { ...process.env, LANGUAGE: lang.replace("-", "_") },
		headless: false,
		// Headless treats the Cocoa array as another URL target; use native headed Chrome on macOS.
		args: [
			...(process.platform === "darwin" ? [] : ["--headless=new"]),
			`--lang=${lang}`,
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--no-proxy-server",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			"--host-resolver-rules=EXCLUDE 127.0.0.1, MAP * ~NOTFOUND",
		],
	});
	browser = context.browser();
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url());
		return url.protocol === "chrome-extension:" || url.origin === origin ? route.continue() : route.abort();
	});
	worker = await poll(
		() => context.serviceWorkers().find((w) => w.url().endsWith("/background.js")),
		"extension worker",
	);
	await poll(() => worker.evaluate(() => Boolean(globalThis.__locale)).catch(() => false), "worker hooks");
	assert(Number.parseInt(browser.version(), 10) >= 147, "Chrome 147+");
	const native = await worker.evaluate(async () => ({
		ui: chrome.i18n.getUILanguage(),
		code: chrome.i18n.getMessage("localeCode"),
		locale: globalThis.__locale.interfaceLocale(),
		label: globalThis.__locale.t("settings"),
		manifest: chrome.runtime.getManifest(),
		commands: await chrome.commands.getAll(),
	}));
	console.log(
		"Native worker:",
		JSON.stringify({
			requested: lang,
			chrome: browser.version(),
			ui: native.ui,
			catalog: native.code,
			locale: native.locale,
		}),
	);
	assert(
		native.ui.toLowerCase().startsWith(lang.toLowerCase()),
		`BLOCKED: actual Chrome UI ${native.ui}, requested ${lang}; no emulated locale coverage`,
	);
	equal(
		`${lang}: worker native catalog and supported fallback`,
		[native.code, native.locale, native.label],
		[expected, expected, message("settings")],
	);
	equal(
		`${lang}: native manifest text`,
		[native.manifest.description, native.manifest.action.default_title, native.manifest.default_locale],
		[message("manifestDescription"), message("openPi"), "en"],
	);
	for (const [name, key] of [
		["ask-selection", "commandAsk"],
		["add-selection", "commandAdd"],
		["open-panel", "commandPanel"],
	])
		equal(`${lang}: native command ${name}`, native.commands.find((c) => c.name === name)?.description, message(key));
	if (seed) {
		equal(
			"new profile answer language defaults to auto",
			await worker.evaluate(async () => (await globalThis.__locale.loadSettings()).language),
			"auto",
		);
		equal(
			"new profile Run script defaults to Ask without enabling Chrome's Allow User Scripts",
			await worker.evaluate(async () => [
				(await globalThis.__locale.loadSettings()).tools.script,
				globalThis.__locale.userScriptsAllowed(),
			]),
			["ask", false],
		);
		await worker.evaluate(async () => {
			await chrome.storage.local.set({
				credentials: { openrouter: { type: "api_key", key: "fabricated-locale-key" } },
			});
			await globalThis.__locale.saveSettings({ model: { provider: "openrouter", modelId: "locale-test" } });
		});
	}
	originals ??= await worker.evaluate(() => globalThis.__locale.originals);
	page = await context.newPage();
	await page.goto(origin);
	tabId = await worker.evaluate(
		async (origin) => (await chrome.tabs.query({})).find((t) => t.url === `${origin}/`).id,
		origin,
	);
	await gesture("attach");
	panel = await context.newPage();
	await panel.setViewportSize({ width: 320, height: 900 });
	await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html?tab=${tabId}`);
	await panel.bringToFront();
	await poll(() => state().then((s) => s?.settings), "panel state");
	const evidence = await panel.evaluate(() => ({
		ui: chrome.i18n.getUILanguage(),
		code: chrome.i18n.getMessage("localeCode"),
		lang: document.documentElement.lang,
	}));
	console.log("Native panel:", JSON.stringify(evidence));
	equal(`${lang}: panel and worker native locale agree; HTML lang`, evidence, {
		ui: native.ui,
		code: expected,
		lang: expected,
	});
}
async function gesture(kind) {
	await page.evaluate(() => {
		const range = document.createRange();
		range.selectNodeContents(document.querySelector("#selection"));
		getSelection().removeAllRanges();
		getSelection().addRange(range);
	});
	await worker.evaluate(
		async ({ tabId, kind }) => {
			const main = globalThis.__localeMain,
				tab = await chrome.tabs.get(tabId);
			const started = main.begin("context-menu", tab, { frameId: 0, url: tab.url, top: tab.url });
			await Promise.all([started.captured, started.resolved]);
			if (kind === "selection") await main.askSelection("context-menu", started, crypto.randomUUID(), "explain");
			if (kind === "draft") await main.askSelection("context-menu", started, crypto.randomUUID(), undefined);
			if (kind === "page") await main.askPage(started, crypto.randomUUID(), "explain");
		},
		{ tabId, kind },
	);
}
function display(preset, choice) {
	const original = originals.find((p) => p.id === preset.id);
	const language = choice === "auto" ? (code === "zh-CN" ? "Chinese" : "English") : choice;
	if (!original || original.name !== preset.name || original.template !== preset.template)
		return preset.name.replaceAll("{{language}}", language);
	return message(
		{
			explain: "presetExplain",
			summarize: "presetSummarize",
			translate: "presetTranslate",
			proofread: "presetProofread",
			reply: "presetReply",
		}[preset.id],
		[message(language === "Chinese" ? "languageChinese" : "languageEnglish")],
	);
}
async function menus(previous = []) {
	const created = await worker.evaluate(async (previous) => {
		const create = chrome.contextMenus.create.bind(chrome.contextMenus),
			calls = [];
		chrome.contextMenus.create = (item, done) => {
			calls.push(item);
			return create(item, done);
		};
		try {
			await chrome.storage.local.set({ menus: previous });
			await globalThis.__locale.buildMenus(false);
			const count = calls.length;
			await globalThis.__locale.buildMenus(false);
			return { calls, count, stored: (await chrome.storage.local.get("menus")).menus };
		} finally {
			chrome.contextMenus.create = create;
		}
	}, previous);
	const s = await state(),
		selection = ["selection"],
		page = ["page"];
	const prompts = (prefix, contexts) =>
		s.settings.prompts.map((p) => ({ id: prefix + p.id, title: display(p, s.settings.language), contexts }));
	const expected = [
		{ id: "ask-pi", title: message("menuAsk"), contexts: selection },
		{ id: "add-to-message", title: message("menuAdd"), contexts: selection },
		...prompts("preset:", selection),
		{ id: "page-ask", title: message("menuPageAsk"), contexts: page },
		...prompts("page-preset:", page),
	];
	for (const [name, actual, wanted] of [
		[
			"native menu comparison repairs changed titles only",
			created.calls.slice(0, created.count),
			JSON.stringify(previous) === JSON.stringify(expected) ? [] : expected,
		],
		["native menu callbacks committed expected titles", created.stored, expected],
		["identical menus do not rebuild", created.calls.length, created.count],
	]) {
		try {
			equal(`${code}: ${name}`, actual, wanted);
		} catch (error) {
			console.error(
				`FAIL ${code}: ${name}`,
				JSON.stringify({
					first: created.count,
					total: created.calls.length,
					stored: created.stored[0],
					expected: expected[0],
				}),
			);
			menuErrors.push(error);
		}
	}
	return expected;
}
async function ui() {
	await staticLabels();
	await sweep("empty chat");
	await settingsView(true);
	check(
		`${code}: Run script is Ask by default in Settings`,
		await panel.locator('input[name="tool-script"][value="ask"]').isChecked(),
	);
	equal(
		`${code}: Chrome script availability is explained without changing it`,
		await panel.locator("#user-scripts").textContent(),
		message(
			(await worker.evaluate(() => globalThis.__locale.userScriptsAllowed())) ? "userScriptsOn" : "userScriptsOff",
		),
	);
	const settings = (await state()).settings;
	equal(
		`${code}: prompt display labels`,
		await panel.locator(".prompt-head .name").allTextContents(),
		settings.prompts.map((p) => display(p, settings.language)),
	);
	await panel.locator('[aria-controls="key-body-openai"]').click();
	const search = panel.getByRole("group", { name: message("webSearch"), exact: true });
	check(
		`${code}: Web search defaults to On`,
		(await search.getByRole("radio", { name: message("on"), exact: true }).isChecked()) &&
			(await state()).settings.openaiWebSearch === true,
	);
	await panel.locator('[aria-controls="key-body-deepseek"]').click();
	const keyBody = panel.locator("#key-body-deepseek");
	check(
		`${code}: key privacy and provider labels`,
		(await keyBody.textContent()).includes(message("keyPrivacy", ["api.deepseek.com"])),
	);
	await panel.locator("#settings .advanced").evaluate((el) => {
		el.open = true;
	});
	await sweep("Settings, with two providers and Advanced open");
	check(
		`${code}: 320px settings have no horizontal overflow`,
		await panel.evaluate(() =>
			[document.documentElement, document.querySelector("#settings .view-body")].every(
				(el) => el.scrollWidth <= el.clientWidth + 1,
			),
		),
	);
	await keyBody.getByRole("button", { name: message("cancel"), exact: true }).click();
	await deleteConfirmation();
	const callback = await context.newPage();
	await callback.goto(`chrome-extension://${new URL(worker.url()).host}/chatgpt-callback.html`);
	await poll(
		() =>
			callback
				.locator("#title")
				.textContent()
				.then((text) => text === message("notSignedIn")),
		"callback without a sign-in",
	);
	equal(
		`${code}: callback HTML lang and label`,
		await callback.evaluate(() => [document.documentElement.lang, document.querySelector("#done").textContent]),
		[code, message("gotIt")],
	);
	equal(`${code}: callback made no network fetch`, await callback.evaluate(() => globalThis.__unexpectedFetch), []);
	await callback.close();
	await panel.bringToFront();
	await settingsView(false);
	check(
		`${code}: 320px chat has no horizontal overflow`,
		await panel.evaluate(() =>
			[document.documentElement, document.querySelector("#transcript")].every(
				(el) => el.scrollWidth <= el.clientWidth + 1,
			),
		),
	);
}
async function language(choice) {
	await settingsView(true);
	await panel.locator("#language").selectOption(choice);
	await poll(() => state().then((s) => s.settings.language === choice), "answer language save");
	equal(
		`${code}: ${choice} does not change interface`,
		await panel.locator("#open-settings").getAttribute("aria-label"),
		message("settings"),
	);
	await settingsView(false);
}
const idle = () =>
	poll(() => state().then((s) => !s.chat.busy && s.chat.entries.at(-1)?.role === "assistant"), "answer idle");
async function fresh() {
	if (await panel.locator("#new-chat").isDisabled()) {
		assert.equal((await state()).chat.entries.length, 0, "only an empty chat needs no reset");
		return;
	}
	const rev = (await state()).rev;
	await panel.locator("#new-chat").click();
	await poll(() => state().then((s) => s.rev === rev + 1), "new chat");
}
async function answer(kind, expected, mode = "answer") {
	await fresh();
	await worker.evaluate((mode) => globalThis.__locale.script(mode), mode);
	if (kind === "summary") await panel.getByRole("button", { name: message("summarizePage"), exact: true }).click();
	else if (kind === "plain") {
		await panel
			.locator("#composer")
			.fill(
				mode === "stop-error" || mode === "abort" || mode === "complete"
					? `Stop announcement ${mode} / ${code}`
					: "Keep this exact user text / 用户文本",
			);
		await panel.locator("#send").click();
	} else await gesture(kind);
	await poll(() => worker.evaluate(() => globalThis.__locale.requests.length > 0), "faux request");
	if (mode === "stop-error" || mode === "complete") {
		await poll(() => state().then((s) => s.chat.busy), "panel sees focused answer in progress");
		await worker.evaluate(() => {
			const release = globalThis.__locale.release;
			delete globalThis.__locale.release;
			release();
		});
	}
	if (mode === "abort") {
		// The SDK retains an aborted assistant entry only after a partial answer has been committed.
		await poll(() => state().then((s) => s.chat.live?.text), "partial answer before Stop");
		await panel.locator("#stop").click();
	}
	await idle();
	const sent = await worker.evaluate(() => globalThis.__locale.requests[0]);
	const text = (content) => (typeof content === "string" ? content : content.map((p) => p.text ?? "").join(""));
	check(
		`${code}: ${kind} system instruction resolves ${expected}`,
		sent.messages.some(
			(m) =>
				m.role === "system" &&
				`${text(m.content)}\n${m.sections?.language ?? ""}`.includes(
					`Reply in ${expected} unless the user asks for another language.`,
				),
		),
	);
	const input = text(sent.messages.findLast((m) => m.role === "user").content);
	if (kind !== "plain")
		check(
			`${code}: ${kind} keeps English instruction with canonical ${expected}`,
			input.includes(`Answer in ${expected}.`) &&
				!input.includes("{{language}}") &&
				!input.includes("Answer in auto."),
		);
	if (kind === "selection")
		check(
			`${code}: selection expansion keeps source text`,
			input.includes("Selected ORIGINAL 文本") && input.includes("Explain this text from"),
		);
	if (kind === "page") check(`${code}: page expansion keeps English template`, input.includes("(the attached page)"));
	if (mode === "answer") {
		// Each tooltip row is one of this catalog's usage rows, with its value.
		const row = (key) =>
			new RegExp(
				`^${message(key, ["\0", "\0"])
					.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					.replaceAll("\0", ".+")}$`,
			);
		const chatRows = [
			"usageInput",
			"usageOutput",
			"usageCacheRead",
			"usageCacheWrite",
			"usageCacheHit",
			"usageCost",
			"usagePlanCost",
			"usageContext",
			"usageContextUnknown",
			"usageCompaction",
		].map(row);
		// An answer's sections, a blank line apart; a tool's row is its name and count.
		const answerRows = [
			"answerTime",
			"answerTimeSplit",
			"answerTools",
			"toolCallsFailed",
			"answerTokens",
			"answerCost",
			"answerPlanCost",
		].map(row);
		answerRows.push(/^$/, /^\S+ ×\d+$/);
		const tips = {
			chat: (await panel.locator("#chat-usage").getAttribute("title")).split("\n"),
			answer: (await panel.locator(".answer-stats, .usage-hint").last().getAttribute("title")).split("\n"),
		};
		const ok =
			tips.chat[0] === message("usageChatScope") &&
			tips.chat.at(-1) === message("usageCompaction") &&
			tips.chat.slice(1).every((tip) => chatRows.some((pattern) => pattern.test(tip))) &&
			tips.answer.every((tip) => answerRows.some((pattern) => pattern.test(tip))) &&
			tips.answer.some((tip) => answerRows[4].test(tip));
		if (!ok) console.error("Usage tooltips:", tips);
		check(`${code}: usage tooltips explain the line row by row in the interface language`, ok);
	}
	if (mode === "complete")
		equal(
			`${code}: ${kind} normal completion has no stopped marker and announces complete`,
			[
				(await state()).chat.entries.findLast((entry) => entry.role === "assistant").stopped,
				await panel.locator("#announcer").textContent(),
			],
			[undefined, message("answerComplete")],
		);
	if (mode === "read") {
		const reads = (await state()).chat.entries.filter((e) => e.read === "page");
		check(
			`${code}: read notices localize and merge by read metadata`,
			reads.length === 1 &&
				reads[0].text.includes(message("readPageNotice", ["Locale fixture"])) &&
				reads[0].text.includes(message("readCount", ["", 2]).trim()),
		);
		check(
			`${code}: production read notice is rendered`,
			(await panel.locator("#transcript").textContent()).includes(reads[0].text),
		);
	}
}
async function stopAnnouncements() {
	const expected = code === "zh-CN" ? "Chinese" : "English";
	await answer("plain", expected, "stop-error");
	const failed = (await state()).chat.entries.findLast((entry) => entry.role === "assistant");
	equal(
		`${code}: provider error matching Stop stays raw and has no stopped marker`,
		[failed.error, failed.stopped],
		[message("answerStopped"), undefined],
	);
	equal(
		`${code}: provider error matching Stop announces failure`,
		await panel.locator("#announcer").textContent(),
		message("answerFailed", [message("answerStopped")]),
	);
	await answer("plain", expected, "abort");
	equal(
		`${code}: Stop control projects actual aborted metadata`,
		(await state()).chat.entries.findLast((entry) => entry.role === "assistant").stopped,
		true,
	);
	equal(
		`${code}: actual abort announces localized Stop`,
		await panel.locator("#announcer").textContent(),
		message("answerStopped"),
	);
	// Only this cloned snapshot differs from production state; native locale and stored errors stay untouched.
	const otherStop = catalogs[code === "zh-CN" ? "en" : "zh_CN"].answerStopped.message;
	assert.notEqual(otherStop, message("answerStopped"));
	equal(
		`${code}: stopped metadata wins over an error from another catalog`,
		await panel.evaluate((error) => {
			const next = structuredClone(globalThis.__localeState());
			next.chat.entries.findLast((entry) => entry.role === "assistant").error = error;
			const announcer = document.querySelector("#announcer"),
				saved = announcer.textContent;
			try {
				globalThis.__localeAnnounceChanges({ ...next, chat: { ...next.chat, busy: true } }, next);
				return announcer.textContent;
			} finally {
				announcer.textContent = saved;
			}
		}, otherStop),
		message("answerStopped"),
	);
	await answer("plain", expected, "complete");
}
async function validation() {
	await settingsView(true);
	const before = (await state()).settings.callsPerAnswer;
	await panel.locator("#calls-per-answer").fill("1");
	await panel.locator("#calls-per-answer").dispatchEvent("change");
	equal(
		`${code}: localized range validation`,
		await panel.locator("#tools-saved").textContent(),
		message("callsRange", [5, 200]),
	);
	equal(`${code}: invalid setting rolls back`, await panel.locator("#calls-per-answer").inputValue(), String(before));
	await worker.evaluate(() => {
		const set = chrome.storage.local.set.bind(chrome.storage.local);
		chrome.storage.local.set = async (items) => {
			if (items.settings !== undefined) {
				chrome.storage.local.set = set;
				throw Error("TEST storage failure");
			}
			return set(items);
		};
	});
	const prior = (await state()).settings.language;
	await panel.locator("#language").selectOption(prior === "Chinese" ? "English" : "Chinese");
	await poll(
		() =>
			panel
				.locator("#language-saved")
				.textContent()
				.then((text) => text === message("notSaved", ["TEST storage failure"])),
		"failed settings save",
	);
	equal(
		`${code}: failed language save restores control and storage`,
		[await panel.locator("#language").inputValue(), (await stored()).language],
		[prior, prior],
	);
	await settingsView(false);
}
async function safePrompts() {
	await settingsView(true);
	const row = panel.locator("#prompts > li").nth(1);
	await row.locator(".edit").click();
	equal(
		"editor uses canonical English name and body",
		[await row.locator('input[id^="prompt-name-"]').inputValue(), await row.locator("textarea").inputValue()],
		[originals[1].name, originals[1].template],
	);
	await row.locator("textarea").fill(`${originals[1].template}\nCUSTOM template-only edit 中文`);
	await row.getByRole("button", { name: message("save"), exact: true }).click();
	await poll(
		() => state().then((s) => s.settings.prompts[1].template.endsWith("CUSTOM template-only edit 中文")),
		"template save",
	);
	equal("template-only save never stores a translated name", (await state()).settings.prompts[1].name, "Summarize");
	await command({ type: "save-prompt", prompt: { ...originals[3], name: "My renamed proofread 中文" } });
	await command({
		type: "save-prompt",
		prompt: {
			id: "custom",
			name: "Custom {{language}} 中文",
			template: "My custom text {{selection}} / {{language}}",
		},
	});
	await command({ type: "move-prompt", promptId: "custom", by: -10 });
	await command({ type: "delete-prompt", promptId: "reply" });
	await command({ type: "set-settings", settings: { defaultPreset: "custom" } });
	await poll(
		() => state().then((s) => s.settings.defaultPreset === "custom" && s.settings.prompts[0].id === "custom"),
		"prompt changes",
	);
	await panel.locator("#add-prompt").click();
	const added = panel.locator("#prompts > li").last();
	equal(
		"new prompt instruction body stays English",
		await added.locator("textarea").inputValue(),
		"\n\n{{selection}}\n\nAnswer in {{language}}.",
	);
	await added.getByRole("button", { name: message("save"), exact: true }).click();
	check(
		"empty prompt name gets localized validation",
		(await added.textContent()).includes(message("promptNameRequired")),
	);
	await added.getByRole("button", { name: message("cancel"), exact: true }).click();
	await settingsView(false);
}
async function deleteConfirmation(cancel = true) {
	const before = cancel ? await command({ type: "list-chats" }) : null;
	await panel.locator("#delete-chats").click();
	if (cancel) await sweep("Delete all chats confirmation");
	check(
		`${code}: destructive confirmation focuses Cancel`,
		await panel.locator("#cancel-delete").evaluate((el) => el === document.activeElement),
	);
	if (cancel) {
		await panel.locator("#cancel-delete").click();
		check(
			`${code}: Cancel closes the destructive confirmation`,
			!(await panel.locator("#delete-confirm").isVisible()),
		);
		equal(`${code}: Cancel preserves all chats`, await command({ type: "list-chats" }), before);
	}
}
async function historyActions(target, expectedTitle) {
	const before = (await command({ type: "list-chats" })).find((chat) => chat.id === target);
	assert(before, "the history fixture must exist");
	if (expectedTitle !== undefined) equal("native locale restart keeps a user chat title", before.title, expectedTitle);
	// Exercise Undo on an archived row; edit.mjs removes the tab's own chat.
	if ((await state()).chat.conversationId === target) await fresh();
	await panel.locator("#open-history").click();
	const row = (title) =>
		panel.locator("#history-list .history-item").filter({ has: panel.getByText(title, { exact: true }) });
	await row(before.title).waitFor({ state: "visible" });
	equal(
		`${code}: History more accessibility preserves user title`,
		await row(before.title).locator(".chat-more").getAttribute("aria-label"),
		message("moreForChat", [before.title]),
	);
	await row(before.title).locator(".chat-more").click();
	await sweep("History with a chat's menu open");
	await row(before.title)
		.getByRole("menuitem", { name: message("rename"), exact: true })
		.click();
	const input = panel.getByRole("textbox", { name: message("chatTitle"), exact: true });
	equal(`${code}: rename starts with the user's title`, await input.inputValue(), before.title);
	const title = `${code} user title / 自定义标题`;
	await input.fill(title);
	await input.press("Enter");
	await poll(
		() => command({ type: "list-chats" }).then((chats) => chats.find((chat) => chat.id === target)?.title === title),
		"renamed history title",
	);
	await row(title).waitFor({ state: "visible" });
	await row(title).locator(".chat-more").click();
	// Chrome for Testing on Linux crashes (signal 11 in the browser process) when a download starts with its UI in
	// zh-CN. There the export is read from the link the panel clicks, before Chrome would download it.
	const inPage = process.platform === "linux" && code === "zh-CN";
	if (inPage)
		await panel.evaluate(() => {
			const click = HTMLAnchorElement.prototype.click;
			HTMLAnchorElement.prototype.click = function () {
				HTMLAnchorElement.prototype.click = click;
				// Not fetch: the suite stubs it to catch network use.
				const request = new XMLHttpRequest();
				request.open("GET", this.href, false);
				request.send();
				globalThis.__exported = request.responseText;
			};
		});
	const downloading = inPage ? undefined : panel.waitForEvent("download");
	await row(title)
		.getByRole("menuitem", { name: message("exportMarkdown"), exact: true })
		.click();
	let markdown;
	if (inPage) {
		await poll(() => panel.evaluate(() => globalThis.__exported !== undefined), "export link");
		markdown = await panel.evaluate(() => globalThis.__exported);
	} else {
		const download = await downloading;
		const path = join(dir, `history-${code}.md`);
		await download.saveAs(path);
		markdown = readFileSync(path, "utf8");
	}
	check(
		`${code}: Markdown export preserves user title, content and raw error`,
		markdown.startsWith(`# ${title}\n`) &&
			markdown.includes("Keep this exact user text / 用户文本") &&
			markdown.includes(rawError),
	);
	await poll(
		() =>
			panel
				.locator("#announcer")
				.textContent()
				.then((text) => text === message("exported")),
		"localized export status",
	);
	check(`${code}: export announces localized status`);
	await row(title).locator(".chat-more").click();
	await row(title)
		.getByRole("menuitem", { name: message("removeFromHistory"), exact: true })
		.click();
	const undo = panel.locator("#history-note").getByRole("button", { name: message("undo"), exact: true });
	await undo.waitFor({ state: "visible" });
	equal(
		`${code}: removal message preserves the user's title`,
		await panel.locator("#history-note").textContent(),
		`${message("removedChat", [title])} ${message("undo")}`,
	);
	equal(`${code}: removed chat leaves History`, await row(title).count(), 0);
	equal(
		`${code}: removal announces localized status`,
		await panel.locator("#announcer").textContent(),
		message("removedFromHistory"),
	);
	await undo.click();
	await row(title).waitFor({ state: "visible" });
	const restored = await command({ type: "export-chat", target });
	check(
		`${code}: Undo restores the title and original content`,
		restored.title === title &&
			restored.markdown.includes(rawError) &&
			restored.markdown.includes("Keep this exact user text / 用户文本"),
	);
	await panel.locator("#close-history").click();
	return title;
}
async function scriptCards() {
	// Rendering/wiring only: no script executes and Chrome's Allow User Scripts is never enabled.
	await panel.evaluate(() => {
		const hook = globalThis.__localeCard;
		hook.originalRequest = hook.client.request;
		hook.replies = [];
		hook.client.request = (cmd) => {
			if (cmd.type === "answer-ask" && cmd.askId.startsWith("locale-script-")) {
				hook.replies.push(cmd);
				return Promise.resolve();
			}
			return hook.originalRequest.call(hook.client, cmd);
		};
		const fixture = document.createElement("div");
		fixture.id = "locale-script-fixture";
		fixture.style.cssText = "position:fixed;inset:60px 8px auto;z-index:100;background:var(--bg)";
		document.body.append(fixture);
	});
	try {
		for (const [key, reply] of [
			["run", "allow"],
			["runForAnswer", "answer"],
			["runForChat", "chat"],
			["deny", "deny"],
		]) {
			await panel.evaluate((reply) => {
				document.querySelector("#locale-script-fixture").replaceChildren(
					globalThis.__localeCard.node({
						id: `locale-script-${reply}`,
						kind: "script",
						origin: "https://fixture.invalid",
						summary: "Original summary / 原始说明",
						code: "return 'UNCHANGED 中文';",
					}),
				);
			}, reply);
			const card = panel.locator("#locale-script-fixture .ask");
			if (reply === "allow") {
				await sweep("a script card");
				equal(
					`${code}: script reach is one localized line`,
					await card.locator(":scope > p").last().textContent(),
					message("scriptAskWarning", ["fixture.invalid"]),
				);
				check(
					`${code}: script summary is not translated`,
					(await card.locator(":scope > p").first().textContent()).includes("Original summary / 原始说明"),
				);
				equal(
					`${code}: script source is not translated`,
					await card.locator("pre").textContent(),
					"return 'UNCHANGED 中文';",
				);
				// The sweep leaves out messages with substitutions: these tooltips name the site.
				for (const [button, tip] of [
					["runForAnswer", "runForAnswerTip"],
					["runForChat", "runForChatTip"],
				])
					equal(
						`${code}: ${tip}`,
						await card.getByRole("button", { name: message(button), exact: true }).getAttribute("title"),
						message(tip, ["fixture.invalid"]),
					);
			}
			await card.getByRole("button", { name: message(key), exact: true }).click();
			await poll(
				() => panel.evaluate((reply) => globalThis.__localeCard.replies.some((cmd) => cmd.answer === reply), reply),
				"script reply wiring",
			);
			equal(`${code}: ${key} sends ${reply}`, await panel.evaluate(() => globalThis.__localeCard.replies.at(-1)), {
				type: "answer-ask",
				askId: `locale-script-${reply}`,
				answer: reply,
			});
		}
	} finally {
		await panel.evaluate(() => {
			const hook = globalThis.__localeCard;
			hook.client.request = hook.originalRequest;
			delete hook.originalRequest;
			document.querySelector("#locale-script-fixture").remove();
		});
	}
}
async function deleteAll() {
	const chats = await command({ type: "list-chats" });
	assert(chats.length > 0, "deletion must exercise stored chats, not an empty profile");
	const retained = await worker.evaluate(() =>
		chrome.storage.local.get(["settings", "credentials", "chatgptAccount"]),
	);
	assert(
		retained.settings.prompts.some((prompt) => prompt.id === "custom"),
		"retain a real custom prompt fixture",
	);
	assert.equal(retained.credentials.openrouter.key, "fabricated-locale-key");
	await settingsView(true);
	await panel.locator("#settings .advanced").evaluate((el) => {
		el.open = true;
	});
	await deleteConfirmation(false);
	await panel.locator("#confirm-delete").click();
	await poll(
		() =>
			panel
				.locator("#delete-result")
				.textContent()
				.then((text) => text === message("allChatsDeleted")),
		"localized delete result",
	);
	equal(
		`${code}: deletion announces localized success`,
		await panel.locator("#announcer").textContent(),
		message("allChatsDeleted"),
	);
	equal(`${code}: all disposable chats are deleted`, await command({ type: "list-chats" }), []);
	await poll(
		() => state().then((s) => s.chat.conversationId === null && s.chat.entries.length === 0 && s.drafts.length === 0),
		"deleted chat state cleared",
	);
	equal(
		`${code}: deletion keeps settings, edited/custom prompts and credentials`,
		await worker.evaluate(() => chrome.storage.local.get(["settings", "credentials", "chatgptAccount"])),
		retained,
	);
	await panel.reload();
	await poll(() => state().then((s) => s?.settings), "panel after deletion");
	equal(`${code}: deleted chats stay deleted after reload`, await command({ type: "list-chats" }), []);
	equal(
		`${code}: retained settings and credentials survive reload`,
		await worker.evaluate(() => chrome.storage.local.get(["settings", "credentials", "chatgptAccount"])),
		retained,
	);
	await panel.locator("#open-history").click();
	await panel.getByText(message("noEarlierChats"), { exact: true }).waitFor({ state: "visible" });
	equal(`${code}: deleted History has no rows`, await panel.locator("#history-list .history-item").count(), 0);
}
async function draftSnapshot() {
	await command({ type: "set-settings", settings: { selectionAction: "compose", defaultPreset: "explain" } });
	await poll(() => state().then((s) => s.settings.selectionAction === "compose"), "compose setting");
	await gesture("draft");
	await poll(() => panel.locator("#composer").inputValue().then(Boolean), "selection draft");
	const draft = (await state()).drafts.at(-1),
		text = await panel.locator("#composer").inputValue();
	check(
		`${code}: draft resolves its original answer language`,
		text.includes(`Answer in ${code === "zh-CN" ? "Chinese" : "English"}.`),
	);
	await language(code === "zh-CN" ? "English" : "Chinese");
	equal(
		`${code}: answer change does not refill composer or draft snapshot`,
		[await panel.locator("#composer").inputValue(), (await state()).drafts.find((d) => d.id === draft.id)],
		[text, draft],
	);
	await panel.locator("#composer").fill("");
	await command({ type: "discard-draft", draftId: draft.id });
	await command({ type: "set-settings", settings: { selectionAction: "send", defaultPreset: "custom" } });
	await language("auto");
}
try {
	await start("en", "en", true);
	await ui();
	await scriptCards();
	await validation();
	await stopAnnouncements();
	for (const choice of ["auto", "Chinese"]) {
		await language(choice);
		for (const kind of ["selection", "page", "summary"])
			await answer(kind, choice === "auto" ? "English" : choice, kind === "summary" ? "read" : "answer");
	}
	await language("auto");
	await sweep("a chat with an answer and its steps");
	await safePrompts();
	await draftSnapshot();
	await answer("plain", "English", "error");
	const history = await state(),
		oldEntries = history.chat.entries
			.filter((e) => e.role !== "notice")
			.map(({ text, quote, error }) => ({ text, quote, error }));
	check(
		"raw external provider error is unchanged",
		oldEntries.some((e) => e.error === rawError),
	);
	const englishTitle = await historyActions(history.chat.conversationId);
	const saved = await stored(),
		oldMenus = await menus();
	equal("auto survives unrelated prompt/tool saves", saved.language, "auto");
	await panel.reload();
	await poll(() => state().then((s) => s?.settings), "panel reload");
	equal("panel reload preserves auto and prompt edits", (await state()).settings.language, "auto");
	await stop(true);
	await start("zh-CN", "zh-CN");
	equal(
		"locale restart preserves auto, custom/renamed/template edits, order, deletion and default",
		await stored(),
		saved,
	);
	await ui();
	await scriptCards();
	await menus(oldMenus);
	await validation();
	await stopAnnouncements();
	await command({ type: "open-chat", rev: (await state()).rev, target: history.chat.conversationId });
	await poll(() => state().then((s) => s.chat.conversationId === history.chat.conversationId), "stored conversation");
	equal(
		"locale restart keeps existing conversation and raw external error",
		(await state()).chat.entries
			.filter((e) => e.role !== "notice")
			.map(({ text, quote, error }) => ({ text, quote, error })),
		oldEntries,
	);
	await historyActions(history.chat.conversationId, englishTitle);
	for (const choice of ["auto", "English"]) {
		await language(choice);
		for (const kind of ["selection", "page", "summary"])
			await answer(kind, choice === "auto" ? "Chinese" : choice, kind === "summary" ? "read" : "answer");
	}
	await language("auto");
	await sweep("a chat with an answer and its steps");
	await draftSnapshot();
	// Repeat the template-only editor save under Chinese, where a translated name must never leak into storage.
	await settingsView(true);
	const explain = panel.locator("#prompts > li").nth(1);
	await explain.locator(".edit").click();
	equal(
		"Chinese editor retains canonical name and English body",
		[await explain.locator('input[id^="prompt-name-"]').inputValue(), await explain.locator("textarea").inputValue()],
		[originals[0].name, originals[0].template],
	);
	await explain.locator("textarea").fill(`${originals[0].template}\nEdited in Chinese UI`);
	await explain.getByRole("button", { name: message("save"), exact: true }).click();
	await poll(
		() =>
			state().then((s) =>
				s.settings.prompts.find((p) => p.id === "explain").template.endsWith("Edited in Chinese UI"),
			),
		"Chinese template edit",
	);
	equal(
		"Chinese template-only save keeps canonical name",
		(await stored()).prompts.find((p) => p.id === "explain").name,
		"Explain",
	);
	equal(
		"template-edited built-in is no longer translated",
		await explain.locator(".prompt-head .name").textContent(),
		"Explain",
	);
	await settingsView(false);
	await language("Chinese");
	const explicit = await stored(),
		chineseMenus = await menus();
	await stop(true);
	await start("fr", "en");
	equal("unsupported native locale preserves existing explicit answer choice", await stored(), explicit);
	await settingsView(true);
	equal(
		"unsupported locale falls back to English labels",
		await panel.locator("#answers-title").textContent(),
		"Answers",
	);
	await settingsView(false);
	await menus(chineseMenus);
	await answer("plain", "Chinese");
	await language("auto");
	await answer("summary", "English");
	equal(
		"unsupported locale resolves auto at request time without changing storage",
		(await stored()).language,
		"auto",
	);
	const frenchMenus = await menus();
	await stop(true);
	await start("zh-TW", "en");
	await settingsView(true);
	equal("native zh-TW falls back to English UI", await panel.locator("#answers-title").textContent(), "Answers");
	await settingsView(false);
	await menus(frenchMenus);
	await answer("summary", "English");
	equal("native zh-TW auto remains auto in storage", (await stored()).language, "auto");
	await stop(true);
	// Destructive coverage is last, after every cross-locale preservation assertion, in this suite's profile only.
	await start("zh-CN", "zh-CN");
	await deleteAll();
	await stop(true);
	if (menuErrors.length) throw new AggregateError(menuErrors, "Native menu comparison failures (see FAIL lines)");
	console.log(`${checks} checks passed.`);
} catch (error) {
	console.error(`FAILED after ${checks} checks:`, error);
	writeFileSync(
		join(dir, "failure.json"),
		JSON.stringify(
			await worker
				?.evaluate(async () => ({
					requests: globalThis.__locale?.requests,
					settings: await globalThis.__locale?.loadSettings(),
					fetches: globalThis.__unexpectedFetch,
				}))
				.catch(() => null),
			null,
			2,
		),
	);
	if (panel) {
		console.error(
			"Panel:",
			await panel
				.locator("body")
				.textContent()
				.catch(() => "unavailable"),
		);
		console.error(
			"Layout:",
			await panel
				.evaluate(() => ({
					visibility: document.visibilityState,
					size: [innerWidth, innerHeight],
					settings: document.querySelector("#open-settings").getBoundingClientRect().toJSON(),
				}))
				.catch(() => null),
		);
		await panel.screenshot({ path: join(dir, "failure.png"), timeout: 5000 }).catch(() => {});
	}
	throw error;
} finally {
	await stop();
	await new Promise((resolve) => site.close(resolve));
	rmSync(profile, { recursive: true, force: true });
}
