// The page OpenAI's sign-in redirect reaches through the worker's session rule, query kept (design 6.20). It hands the
// query to the worker and shows the outcome; on the first sign-in, OpenAI's welcome.

import { localizeDocument, t } from "../shared/i18n.ts";
import { CHATGPT, type ChatGPTCallbackReply } from "../shared/protocol.ts";

localizeDocument(document);

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`missing #${id}`);
	return found as T;
}

const ui = {
	title: element("title"),
	text: element("text"),
	actions: element("actions"),
	usage: element<HTMLAnchorElement>("usage"),
	done: element<HTMLButtonElement>("done"),
};

/** Closes this tab; Chrome then shows the tab that started the sign-in. */
async function close(): Promise<void> {
	const tab = await chrome.tabs.getCurrent();
	if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}

function show(title: string, text: string, usage: boolean): void {
	ui.title.textContent = title;
	ui.text.textContent = text;
	ui.usage.hidden = !usage;
	ui.actions.hidden = false;
}

const search = location.search;
// The code is useless without the worker's verifier, but the history entry need not keep it.
history.replaceState(null, "", location.pathname);
ui.usage.href = CHATGPT.usageUrl;
ui.done.addEventListener("click", () => void close());

chrome.runtime.sendMessage({ type: "chatgpt-callback", search }).then(
	(reply: ChatGPTCallbackReply | undefined) => {
		if (reply === undefined) {
			show(t("notSignedIn"), t("callbackNoReply"), false);
		} else if (!reply.ok) {
			show(t("notSignedIn"), reply.error, false);
		} else if (reply.welcome) {
			show(t("callbackPlanTitle"), t("callbackPlanNote"), true);
			ui.done.focus();
		} else {
			show(t("signedInChatGPT"), t("callbackBack"), false);
			void close();
		}
	},
	(error: unknown) => show(t("notSignedIn"), t("callbackError", [String(error)]), false),
);
