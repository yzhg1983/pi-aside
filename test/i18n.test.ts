import { readdirSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { answerHelp, answerLine, usageHelp } from "../src/panel/format.ts";
import { interfaceLocale, localizeDocument, type MessageKey, t } from "../src/shared/i18n.ts";
import english from "../static/_locales/en/messages.json" with { type: "json" };
import chinese from "../static/_locales/zh_CN/messages.json" with { type: "json" };

afterEach(() => vi.unstubAllGlobals());

function nativeChinese(): void {
	vi.stubGlobal("chrome", {
		i18n: {
			getMessage: (key: MessageKey, values: string[] = []) =>
				chinese[key].message.replace(/\$\$|\$([1-9])/g, (_match, index: string | undefined) =>
					index === undefined ? "$" : (values[Number(index) - 1] ?? ""),
				),
		},
	});
}

it("has exactly two complete catalogs with matching numeric placeholders", () => {
	expect(readdirSync(new URL("../static/_locales/", import.meta.url)).sort()).toEqual(["en", "zh_CN"]);
	expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
	const placeholders = (message: string) =>
		[...message.matchAll(/\$\$|\$([1-9])/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])).sort();
	for (const key of Object.keys(english) as MessageKey[]) {
		expect(key).toMatch(/^[a-z][a-zA-Z0-9]*$/);
		expect(english[key].message.trim(), key).not.toBe("");
		expect(chinese[key].message.trim(), key).not.toBe("");
		expect(placeholders(chinese[key].message), key).toEqual(placeholders(english[key].message));
	}
});

it("falls back without Chrome, i18n, getMessage, or a native translation", () => {
	for (const chrome of [
		undefined,
		{},
		{ i18n: {} },
		{ i18n: { getUILanguage: () => "fr" } },
		{ i18n: { getMessage: () => "" } },
	]) {
		vi.stubGlobal("chrome", chrome);
		expect(t("menuAsk")).toBe("Ask pi");
		expect(t("presetTranslate", ["Chinese"])).toBe("Translate to Chinese");
		expect(interfaceLocale()).toBe("en");
	}
});

it("falls back synchronously when native getMessage returns a non-string", () => {
	for (const value of [Promise.resolve("native"), {}, 42, true, null, undefined]) {
		vi.stubGlobal("chrome", { i18n: { getMessage: () => value } });
		expect(t("menuAsk")).toBe("Ask pi");
		expect(t("presetTranslate", ["Chinese"])).toBe("Translate to Chinese");
		expect(interfaceLocale()).toBe("en");
	}
});

it("uses native Chinese and resolves the interface from the catalog, not preferred languages", () => {
	nativeChinese();
	expect(t("menuAsk")).toBe("询问 pi");
	expect(t("presetTranslate", [t("languageEnglish")])).toBe("翻译为英语");
	expect(interfaceLocale()).toBe("zh-CN");
	vi.stubGlobal("chrome", { i18n: { getMessage: () => "", getUILanguage: () => "zh-TW" } });
	expect(interfaceLocale()).toBe("en");
});

it("matches numeric substitutions and literal dollars without re-expanding inserted text", () => {
	vi.stubGlobal("chrome", undefined);
	const original = english.presetTranslate.message;
	try {
		english.presetTranslate.message = "$$ $1 $$1 $9 $2";
		expect(t("presetTranslate", ["<b>$2 {{language}}</b>", 42])).toBe("$ <b>$2 {{language}}</b> $1  42");
	} finally {
		english.presetTranslate.message = original;
	}
});

it("fails on a missing English definition even when a native catalog returns a value", () => {
	vi.stubGlobal("chrome", { i18n: { getMessage: () => "native" } });
	expect(() => t("missingDefinition" as MessageKey)).toThrow("Missing English message");
});

it("defines every explicit HTML marker and native manifest message", () => {
	for (const path of ["../static/panel.html", "../static/chatgpt-callback.html"]) {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		for (const match of source.matchAll(/data-i18n(?:-(?:title|placeholder|aria-label|alt))?="([^"]+)"/g))
			expect(english, match[1]).toHaveProperty(match[1]!);
		// A text marker must not erase an input, icon, or another label.
		for (const match of source.matchAll(/<([\w-]+)\b[^>]*\bdata-i18n="[^"]+"[^>]*>([\s\S]*?)<\/\1>/g))
			expect(match[2], match[0]).not.toMatch(/<\w/);
	}
	const manifest = readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8");
	expect(JSON.parse(manifest).default_locale).toBe("en");
	for (const match of manifest.matchAll(/__MSG_(\w+)__/g)) expect(english).toHaveProperty(match[1]!);
});

it("localizes new controls without changing user titles, script summaries, or raw errors", () => {
	const content = "<script>原文 $2 {{language}}</script>";
	expect(t("runForAnswer")).toBe("For this answer");
	expect(t("runForChat")).toBe("For this chat");
	expect(t("moreForChat", [content])).toBe(`More for ${content}`);
	nativeChinese();
	expect(t("runForAnswer")).toBe("本次回答");
	expect(t("runForChat")).toBe("本次对话");
	expect(t("moreForChat", [content])).toBe(`${content}的更多操作`);
	expect(t("piSays", [content])).toBe(`pi 说明：${content}`);
	expect(t("notExported", [content])).toBe(`未导出：${content}`);
	expect(t("diagram")).toBe("图表");
	expect(t("viewerFullSize", [t("diagram")])).toBe("图表，原始尺寸");
	expect(t("allChatsDeleted")).toBe("已删除所有对话");
});

it("explains combined estimates, current context, script scopes, and Chrome's script gate in both catalogs", () => {
	for (const catalog of [english, chinese]) {
		for (const [key, { message }] of Object.entries(catalog))
			if (key.startsWith("usage")) expect(message, key).not.toMatch(/\(sub\)|\(auto\)/);
		expect(catalog.scriptAskWarning.message).toContain("$1");
	}
	expect(english.usageCost.message).toContain("not a bill");
	expect(chinese.usageCost.message).toContain("不是账单");
	expect(english.usageContext.message).toContain("window");
	expect(english.scriptWarning.message).toContain('"For this answer" or "For this chat"');
	expect(english.userScriptsOff.message).toContain("pi can't run scripts");
	expect(chinese.userScriptsOff.message).toContain("无法运行脚本");
});

it("explains the usage line row by row in Chinese", () => {
	nativeChinese();
	const usage = { input: 4800, output: 77, cacheRead: 4000, cacheWrite: 0, cost: 0.011, planCost: 0, cacheHit: 0.454 };
	expect(usageHelp(usage, { context: { tokens: 9000, auto: true }, window: 500_000 }).split("\n")).toEqual([
		"整个对话，包括摘要和工具调用",
		"↑ 输入（不含缓存）：4.8k 个令牌",
		"↓ 输出：77 个令牌",
		"R 从缓存读取：4.0k 个令牌",
		"CH 缓存命中：上次请求的 45.4%",
		"费用：约 $0.011，按标价估算，不是账单",
		"上下文：已用 1.8%（窗口：500k 个令牌）",
		"接近上限时，pi 会自动汇总较早的消息。",
	]);
	const stats = { modelMs: 9100, toolMs: 3300, tools: [{ name: "read_page", calls: 2, failed: 1 }] };
	expect(answerLine(stats)).toBe("12.4s · 2 次工具调用");
	expect(answerHelp({ ...usage, cacheHit: 0.45 }, stats).split("\n")).toEqual([
		"用时：12.4s（模型 9.1s · 工具 3.3s）",
		"",
		"工具：",
		"read_page ×2（1 次失败）",
		"",
		"令牌：输入 8.8k（45% 来自缓存） · 输出 77",
		"费用：约 $0.011",
	]);
});

it("localizes only marked text and attributes, leaving surrounding controls in place", () => {
	nativeChinese();
	const textNode = { dataset: { i18n: "menuAsk" }, textContent: "Ask pi" };
	const attributes = new Map([["data-i18n-placeholder", "message"]]);
	const input = {
		getAttribute: (name: string) => attributes.get(name),
		setAttribute: (name: string, value: string) => attributes.set(name, value),
	};
	const root = {
		documentElement: { lang: "en" },
		querySelectorAll: (selector: string) =>
			selector === "[data-i18n]" ? [textNode] : selector === "[data-i18n-placeholder]" ? [input] : [],
	};
	localizeDocument(root as unknown as Document);
	expect(root.documentElement.lang).toBe("zh-CN");
	expect(textNode.textContent).toBe("询问 pi");
	expect(attributes.get("placeholder")).toBe("消息");
});
