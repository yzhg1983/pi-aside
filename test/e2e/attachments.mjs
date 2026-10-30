// Images and text files in the production panel's message box (design 6.42): the picker, a drop, and a paste; what is
// refused and why; Send waiting while files are prepared; an image turned upright by its EXIF orientation, a
// transparent one on white when it must be JPEG, an animated GIF's first frame; previews freed; a file removed while
// it is prepared; the content blocks the provider gets; an image-only box and an incoming draft; Stop and Edit.
// composer.png and sent.png in the artifacts folder show them. Only a loopback page and an in-process faux provider, in
// a disposable Chrome profile and temporary bundle. No installed dist/, accounts, or paid requests.
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
const dir = mkdtempSync(join(tmpdir(), "pi-attachments-"));
const ext = join(dir, "ext");
const profile = join(dir, "profile");
console.log("Artifacts:", dir);
mkdirSync(ext);
cpSync(join(repo, "static"), ext, { recursive: true });
// English labels; localization.mjs covers both catalogs.
rmSync(join(ext, "_locales/zh_CN"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*", "https://openrouter.ai/*"];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

const entry = join(dir, "entry.mjs");
writeFileSync(
	entry,
	`
import ${JSON.stringify(join(repo, "src/background/main.ts"))};
import { models } from ${JSON.stringify(join(repo, "src/background/models.ts"))};
import { saveSettings } from ${JSON.stringify(join(repo, "src/background/settings.ts"))};
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "attach-test" }] });
models.setProvider(faux.provider);
globalThis.fetch = async () => { throw Error("Unexpected network request in attachments test"); };
/** Each request's last user message, block by block. */
const requests = [];
let release;
let requestSignal;
globalThis.__piAttach = {
  saveSettings, requests,
  answer(reply, held = false) {
    const gate = held ? new Promise((resolve) => { release = resolve; }) : undefined;
    faux.setResponses([async (transcript, options) => {
      requestSignal = options?.signal;
      const last = transcript.messages.findLast((message) => message.role === "user");
      const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      requests.push(content.map((block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image", mimeType: block.mimeType, data: block.data }));
      await gate;
      return fauxAssistantMessage(reply);
    }]);
  },
  release() { release?.(); },
  get aborted() { return requestSignal?.aborted === true; },
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
await build({ ...common, entryPoints: [entry], outfile: join(ext, "background.js") });
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts" }, outdir: ext });

const site = createServer((_, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end("<!doctype html><title>Attachments fixture</title><p>A page.</p>");
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${site.address().port}`;

// Files the tests add, built in the panel: Node has no image encoder.
const MAKERS = () => {
	const bytes = (text) => new TextEncoder().encode(text);
	/** A 40 by 20 JPEG, red on the left and blue on the right, marked "rotate 90° clockwise" (EXIF orientation 6). */
	async function rotatedJpeg() {
		const canvas = new OffscreenCanvas(40, 20);
		const draw = canvas.getContext("2d");
		draw.fillStyle = "#f00";
		draw.fillRect(0, 0, 20, 20);
		draw.fillStyle = "#00f";
		draw.fillRect(20, 0, 20, 20);
		const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 1 })).arrayBuffer());
		// APP1: "Exif\0\0", then a big-endian TIFF header with one IFD entry, Orientation (0x0112) = 6.
		const exif = [
			0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
			0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		];
		return new File([jpeg.slice(0, 2), new Uint8Array(exif), jpeg.slice(2)], "rotated.jpg", { type: "image/jpeg" });
	}
	/** A 1 by 1 GIF of two frames, red then blue, looping. */
	function animatedGif() {
		const frame = (index) => [
			0x21,
			0xf9,
			0x04,
			0x00,
			0x0a,
			0x00,
			0x00,
			0x00,
			0x2c,
			0x00,
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			0x01,
			0x00,
			0x00,
			0x02,
			0x02,
			index === 0 ? 0x44 : 0x4c,
			0x01,
			0x00,
		];
		const gif = [
			...bytes("GIF89a"),
			0x01,
			0x00,
			0x01,
			0x00,
			0x80,
			0x00,
			0x00,
			0xff,
			0x00,
			0x00,
			0x00,
			0x00,
			0xff,
			0x21,
			0xff,
			0x0b,
			...bytes("NETSCAPE2.0"),
			0x03,
			0x01,
			0x00,
			0x00,
			0x00,
			...frame(0),
			...frame(1),
			0x3b,
		];
		return new File([new Uint8Array(gif)], "moving.gif", { type: "image/gif" });
	}
	/** Noise on the right half, nothing on the left: too large as PNG, so it goes as JPEG. */
	async function transparentNoise(name, side = 1280) {
		const canvas = new OffscreenCanvas(side, side);
		const draw = canvas.getContext("2d");
		const half = draw.createImageData(side / 2, side);
		for (let at = 0; at < half.data.length; at++) half.data[at] = (at % 4 === 3 ? 255 : Math.random() * 256) | 0;
		draw.putImageData(half, side / 2, 0);
		return new File([await canvas.convertToBlob({ type: "image/png" })], name, { type: "image/png" });
	}
	const text = (name, content, type) =>
		new File([typeof content === "string" ? bytes(content) : content], name, { type });
	/** `files` as the picker, a drop, or a paste gives them; true when the panel took the event. */
	function give(how, files, plain = "") {
		const data = new DataTransfer();
		for (const file of files) data.items.add(file);
		if (plain !== "") data.setData("text/plain", plain);
		if (how === "pick") {
			const input = document.querySelector("#attach-input");
			input.files = data.files;
			input.dispatchEvent(new Event("change"));
			return true;
		}
		if (how === "drop") {
			const target = document.querySelector("#transcript");
			target.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
			return !target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
		}
		const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
		return !document.querySelector("#composer").dispatchEvent(event);
	}
	/** The pixel at `x`, `y` of a base64 image, and its size. */
	async function pixel(mimeType, data, x, y) {
		const bitmap = await createImageBitmap(
			new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mimeType }),
		);
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const draw = canvas.getContext("2d");
		draw.drawImage(bitmap, 0, 0);
		const [r, g, b, a] = draw.getImageData(
			Math.round(x * (bitmap.width - 1)),
			Math.round(y * (bitmap.height - 1)),
			1,
			1,
		).data;
		return { width: bitmap.width, height: bitmap.height, r, g, b, a };
	}
	// Object URLs made and freed; and whether Send was ever enabled while a file was being prepared.
	globalThis.__urls = { created: 0, revoked: 0 };
	const create = URL.createObjectURL.bind(URL);
	const revoke = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = (blob) => {
		globalThis.__urls.created++;
		return create(blob);
	};
	URL.revokeObjectURL = (url) => {
		globalThis.__urls.revoked++;
		revoke(url);
	};
	globalThis.__preparing = { seen: 0, sendEnabled: 0 };
	new MutationObserver(() => {
		if (document.querySelector(".attachment.preparing") === null) return;
		globalThis.__preparing.seen++;
		if (!document.querySelector("#send").disabled) globalThis.__preparing.sendEnabled++;
	}).observe(document.querySelector("#attachments"), { childList: true, subtree: true, attributes: true });
	globalThis.__make = { rotatedJpeg, animatedGif, transparentNoise, text, give, pixel };
};

let context;
let checks = 0;
const problems = [];
function check(name, ok) {
	assert(ok, name);
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
		viewport: { width: 400, height: 800 },
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
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url());
		return url.protocol === "chrome-extension:" || url.hostname === "127.0.0.1" ? route.continue() : route.abort();
	});
	const worker = await poll(() => context.serviceWorkers().find((w) => w.url().endsWith("/background.js")), "worker");
	const id = new URL(worker.url()).host;
	console.log("Chrome:", context.browser().version());
	await poll(() => worker.evaluate(() => Boolean(globalThis.__piAttach)).catch(() => false), "hooks");
	await worker.evaluate(async () => {
		await chrome.storage.local.set({ credentials: { openrouter: { type: "api_key", key: "not-a-real-key" } } });
		await globalThis.__piAttach.saveSettings({ model: { provider: "openrouter", modelId: "attach-test" } });
	});
	const page = await context.newPage();
	await page.goto(origin);
	const tabId = await worker.evaluate(
		async (origin) => (await chrome.tabs.query({})).find((tab) => tab.url === `${origin}/`).id,
		origin,
	);

	const panel = await context.newPage();
	panel.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
	await panel.goto(`chrome-extension://${id}/panel.html?tab=${tabId}`);
	const composer = panel.locator("#composer");
	await composer.waitFor({ state: "visible" });
	await panel.evaluate(MAKERS);
	const chips = panel.locator("#attachments > .attachment");
	const status = panel.locator("#composer-status");
	const send = panel.locator("#send");
	const requests = () => worker.evaluate(() => globalThis.__piAttach.requests.slice());
	const transcript = () => panel.locator(".stream > .entries > *").allTextContents();
	const urls = () => panel.evaluate(() => ({ ...globalThis.__urls }));
	const settled = () => poll(async () => (await panel.locator(".attachment.preparing").count()) === 0, "prepared");
	const answered = async (reply) => {
		await poll(async () => (await transcript()).some((line) => line.includes(reply)), `answer ${reply}`);
		await poll(() => panel.locator("#new-chat").isEnabled(), "answer done");
	};

	// The picker: a CSV that Windows labels as Excel is text; a PDF in ASCII and invalid UTF-8 are not.
	await panel.evaluate(() => {
		const { text, give } = globalThis.__make;
		give("pick", [
			text("data.csv", "name,total\nApples,3\n", "application/vnd.ms-excel"),
			text("report.pdf", "%PDF-1.4\n1 0 obj << >> endobj\n", "application/pdf"),
			text("bad.txt", new Uint8Array([0x61, 0xff, 0x62]), "text/plain"),
		]);
	});
	await settled();
	const refused = await status.textContent();
	check(
		"the picker keeps the text file and names each refused one on one line",
		(await chips.count()) === 1 &&
			(await chips.first().textContent()).includes("data.csv · 20 characters") &&
			refused.includes("report.pdf is not an image or a text file") &&
			refused.includes("bad.txt is not an image or a text file"),
	);

	// Images, by a drop on the transcript: Send waits until they are ready.
	const before = await urls();
	const took = await panel.evaluate(async () => {
		const { rotatedJpeg, animatedGif, transparentNoise, give } = globalThis.__make;
		return give("drop", [await rotatedJpeg(), animatedGif(), await transparentNoise("clear.png")]);
	});
	await settled();
	const preparing = await panel.evaluate(() => globalThis.__preparing);
	check("a drop of files is the panel's, not Chrome's", took);
	check("Send is disabled while files are prepared", preparing.seen > 0 && preparing.sendEnabled === 0);
	const labels = await chips.allTextContents();
	check(
		"each image's chip gives its size as sent: the JPEG upright, the GIF's one frame, the large one at 1280",
		labels.length === 4 &&
			labels[1].startsWith("20 × 40 ·") &&
			labels[2].startsWith("1 × 1 ·") &&
			labels[3].startsWith("1280 × 1280 ·") &&
			(await panel.locator("#attachments .thumb:not([hidden])").count()) === 3,
	);
	await composer.fill("Compare");
	await panel.screenshot({ path: join(dir, "composer.png") });
	await worker.evaluate(() => globalThis.__piAttach.answer("Compared."));
	await send.click();
	await answered("Compared.");
	const [first] = await requests();
	check(
		"the provider gets the text, the file's block, and one image block each, in order",
		JSON.stringify(first.map((block) => block.type)) ===
			JSON.stringify(["text", "text", "image", "image", "image"]) &&
			first[0].text === "Compare" &&
			first[1].text ===
				'[Attached file: "data.csv", 20 characters]\nname,total\nApples,3\n\n[End of file "data.csv"]',
	);
	const [rotated, moving, clear] = await panel.evaluate(
		async (images) =>
			Promise.all([
				globalThis.__make.pixel(images[0].mimeType, images[0].data, 0.5, 0.1),
				globalThis.__make.pixel(images[1].mimeType, images[1].data, 0, 0),
				globalThis.__make.pixel(images[2].mimeType, images[2].data, 0.1, 0.5),
			]),
		first.slice(2),
	);
	check(
		"EXIF orientation: the image is upright, the red half on top",
		rotated.width === 20 && rotated.height === 40 && rotated.r > 200 && rotated.b < 80,
	);
	check("an animated GIF sends its first frame", moving.r > 200 && moving.b < 50);
	check(
		"a transparent image that must be JPEG is on white",
		first[4].mimeType === "image/jpeg" && clear.r > 240 && clear.g > 240 && clear.b > 240,
	);
	const sent = await urls();
	check(
		"the box's previews are freed after the send",
		sent.revoked - before.revoked === 3 && (await chips.count()) === 0,
	);
	const bubble = panel.locator(".turn .msg.user").first();
	await poll(async () => (await bubble.locator(".shot:not([hidden])").count()) === 3, "thumbnails");
	check(
		"the sent message shows its text, its file, and its images",
		(await bubble.textContent()).includes("Compare") &&
			(await bubble.locator(".attachment").textContent()).includes("data.csv"),
	);
	await panel.screenshot({ path: join(dir, "sent.png") });

	// Removed while it waits or while it is prepared: nothing lands, and no preview is made.
	const quiet = await urls();
	const removed = await panel.evaluate(async () => {
		const { transparentNoise, give } = globalThis.__make;
		const files = [await transparentNoise("slow-1.png"), await transparentNoise("slow-2.png")];
		give("pick", files);
		// At once: the first is being prepared, the second waits for it.
		const preparing = document.querySelectorAll("#attachments > .attachment.preparing").length;
		for (const x of [...document.querySelectorAll("#attachments .remove-attachment")].reverse()) x.click();
		return preparing;
	});
	await sleep(1500);
	check(
		"a file removed before it is ready never lands",
		removed === 2 && (await chips.count()) === 0 && (await urls()).created === quiet.created,
	);

	// A paste with text is text; a paste of an image alone attaches it.
	const pastedText = await panel.evaluate(async () =>
		globalThis.__make.give("paste", [globalThis.__make.animatedGif()], "some text"),
	);
	check("a paste that has text is left to the box", !pastedText && (await chips.count()) === 0);
	const pastedImage = await panel.evaluate(async () =>
		globalThis.__make.give("paste", [globalThis.__make.animatedGif()]),
	);
	await settled();
	check("a paste of an image alone attaches it", pastedImage && (await chips.count()) === 1);

	// An image-only box is not empty: a draft that Stop gives back stays a draft. The held message goes first.
	await panel.evaluate(() => {
		const x = document.querySelector("#attachments .remove-attachment");
		x.click();
	});
	await worker.evaluate(() => globalThis.__piAttach.answer("Never shown.", true));
	await composer.fill("hold");
	await composer.press("Enter");
	await poll(async () => (await requests()).length === 2, "held request");
	await composer.fill("queued text");
	await composer.press("Enter");
	await poll(async () => (await panel.locator(".msg.user.queued").count()) === 1, "queued text");
	await panel.evaluate(() => globalThis.__make.give("paste", [globalThis.__make.animatedGif()]));
	await settled();
	await panel.locator("#stop").click();
	await poll(() => worker.evaluate(() => globalThis.__piAttach.aborted), "held request aborted");
	await worker.evaluate(() => globalThis.__piAttach.release());
	const drafts = panel.locator(".draft");
	await poll(async () => (await drafts.count()) === 1, "the draft listed");
	check(
		"with an image in the box, Stop's draft is listed and does not join it",
		(await composer.inputValue()) === "" &&
			(await chips.count()) === 1 &&
			(await drafts.textContent()).includes("queued text"),
	);
	// Its Edit waits too, also for the box's attachments alone, and follows them as they come and go.
	const draftEdit = drafts.getByRole("button", { name: "Edit" });
	const editWaits = await draftEdit.isDisabled();
	await panel.evaluate(() => document.querySelector("#attachments .remove-attachment").click());
	await poll(() => draftEdit.isEnabled(), "draft Edit enabled");
	await panel.evaluate(() => globalThis.__make.give("paste", [globalThis.__make.animatedGif()]));
	await settled();
	check(
		"a draft's Edit waits while the box holds attachments, and is back when they go",
		editWaits && (await draftEdit.isDisabled()) && (await composer.inputValue()) === "",
	);
	await drafts.getByRole("button", { name: "Discard draft" }).click();
	await poll(async () => (await drafts.count()) === 0, "draft discarded");

	// An image-only message, queued, then stopped: its draft says the attachments were not kept.
	await worker.evaluate(() => globalThis.__piAttach.answer("Never shown either.", true));
	await panel.evaluate(() => document.querySelector("#attachments .remove-attachment").click());
	await composer.fill("hold again");
	await composer.press("Enter");
	await poll(async () => (await requests()).length === 3, "second held request");
	await panel.evaluate(() => globalThis.__make.give("paste", [globalThis.__make.animatedGif()]));
	await settled();
	check("an image alone can be sent", await send.isEnabled());
	await send.click();
	await poll(async () => (await panel.locator(".msg.user.queued").count()) === 1, "queued image");
	await panel.locator("#stop").click();
	await poll(() => worker.evaluate(() => globalThis.__piAttach.aborted), "second held request aborted");
	await worker.evaluate(() => globalThis.__piAttach.release());
	await poll(async () => (await status.textContent()).includes("attachments were not kept"), "loss noted");
	check("Stop's draft of an image-only message says it lost the image", (await composer.inputValue()) === "");
	await composer.fill("x");
	await composer.fill("");

	// Edit: the attachments come with the message; ✕ leaves one out.
	const turn = panel.locator(".turn").first();
	await turn.hover();
	await turn.getByRole("button", { name: "Edit message" }).click();
	const editor = turn.locator(".editor");
	const kept = editor.locator(".attachment");
	await poll(async () => (await editor.locator(".thumb:not([hidden])").count()) === 3, "editor thumbnails");
	check("Edit lists the message's attachments", (await kept.count()) === 4);
	await editor.getByRole("button", { name: "Remove data.csv" }).click();
	await editor.locator("textarea").fill("Compare, edited");
	await worker.evaluate(() => globalThis.__piAttach.answer("Edited."));
	await editor.getByRole("button", { name: "Send" }).click();
	await answered("Edited.");
	const edited = (await requests()).at(-1);
	check(
		"the edited message keeps the images it was left with",
		JSON.stringify(edited.map((block) => block.type)) === JSON.stringify(["text", "image", "image", "image"]) &&
			edited[0].text === "Compare, edited",
	);
	check("no panel errors", problems.length === 0);
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
