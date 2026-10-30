// The pi menu: one set of items for selected text, one for the page without a selection (design 6.18). Chrome shows
// one set or the other, never both. It keeps the menu across worker restarts, so it is built on install and after
// each settings change, and checked when a worker starts.

import { t } from "../shared/i18n.ts";
import { effectiveAnswerLanguage } from "../shared/language.ts";
import { presetDisplayName, presetOn } from "../shared/presets.ts";
import { loadSettings } from "./settings.ts";

export const MENU_ASK = "ask-pi";
export const MENU_ADD = "add-to-message";
export const MENU_PRESET = "preset:";
export const MENU_PAGE_ASK = "page-ask";
export const MENU_PAGE_PRESET = "page-preset:";
const MENUS_KEY = "menus";

let menus: Promise<void> = Promise.resolve();

/**
 * For a selection, "Ask pi" follows the selection action setting; "Add to message" puts only the text in the message
 * box; each prompt that is on is an item, which always sends. For the page, "Ask pi about this page" attaches it, and
 * each prompt item sends with the page attached. Chrome groups each set under "pi". The items are stored once they are
 * all created; `always` false builds only when they differ from the settings, which repairs a build that a stopped
 * worker did not finish.
 * One build at a time, until every callback of the last one has come: two at once would create the same IDs twice.
 */
export function buildMenus(always: boolean): Promise<void> {
	const result = menus.then(async () => {
		const { language, prompts } = await loadSettings();
		const selection: ["selection"] = ["selection"];
		const page: ["page"] = ["page"];
		const prompt = (prefix: string, contexts: typeof selection | typeof page) =>
			prompts.filter(presetOn).map((preset) => ({
				id: prefix + preset.id,
				title: presetDisplayName(preset, effectiveAnswerLanguage(language)),
				contexts,
			}));
		const items = [
			{ id: MENU_ASK, title: t("menuAsk"), contexts: selection },
			{ id: MENU_ADD, title: t("menuAdd"), contexts: selection },
			...prompt(MENU_PRESET, selection),
			{ id: MENU_PAGE_ASK, title: t("menuPageAsk"), contexts: page },
			...prompt(MENU_PAGE_PRESET, page),
		];
		const built = (await chrome.storage.local.get(MENUS_KEY))[MENUS_KEY];
		// Native storage may reorder object keys. Compare menu fields, not serialized property order.
		if (
			!always &&
			Array.isArray(built) &&
			built.length === items.length &&
			items.every((item, index) => {
				const candidate: unknown = built[index];
				if (typeof candidate !== "object" || candidate === null) return false;
				const saved = candidate as Record<string, unknown>;
				return (
					saved.id === item.id &&
					saved.title === item.title &&
					Array.isArray(saved.contexts) &&
					saved.contexts.length === item.contexts.length &&
					saved.contexts.every((context: unknown, index: number) => context === item.contexts[index])
				);
			})
		)
			return;
		await chrome.storage.local.remove(MENUS_KEY);
		await menuCall((done) => chrome.contextMenus.removeAll(done));
		const created = await Promise.allSettled(
			items.map((item) => menuCall((done) => chrome.contextMenus.create(item, done))),
		);
		const failed = created.find((outcome) => outcome.status === "rejected");
		if (failed !== undefined) throw failed.reason;
		await chrome.storage.local.set({ [MENUS_KEY]: items });
	});
	menus = result.catch(() => {});
	return result;
}

/** Callbacks: `create()` has no Promise form. An error is in `runtime.lastError` only within the callback. */
function menuCall(call: (done: () => void) => void): Promise<void> {
	return new Promise((resolve, reject) =>
		call(() => {
			const error = chrome.runtime.lastError;
			if (error === undefined) resolve();
			else reject(new Error(error.message ?? t("menuUpdateFailed")));
		}),
	);
}
