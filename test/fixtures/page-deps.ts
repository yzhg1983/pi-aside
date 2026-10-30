// The page extension's dependencies for tests: settings that a test changes, the Ask cards, and the transcript of a
// Harness opened after the extension is installed.

import type { Harness } from "@earendil-works/pi-durable";
import { Asks } from "../../src/background/asks.ts";
import type { PageAccess, PageDeps, PageToolSettings } from "../../src/background/page.ts";
import { CaptureQueue } from "../../src/background/screenshot.ts";

export const ALL_ON: PageToolSettings = {
	tools: { read: "on", observe: "on", act: "on", script: "on", screenshot: "on" },
	callsPerAnswer: 50,
};

/** Page access without the agent: for tests of read_page alone. */
export const NO_AGENT: Pick<
	PageAccess,
	| "top"
	| "observe"
	| "act"
	| "navigate"
	| "loaded"
	| "scripts"
	| "scriptWorld"
	| "script"
	| "media"
	| "locate"
	| "scroll"
	| "tabState"
	| "allSites"
	| "leadsTo"
	| "changes"
	| "watch"
	| "opened"
	| "close"
	| "switchBack"
	| "capture"
	| "encode"
> = {
	top: async () => null,
	observe: async () => null,
	act: async () => null,
	navigate: async () => {},
	loaded: async () => true,
	scripts: () => false,
	scriptWorld: async () => {},
	script: async () => null,
	media: async () => null,
	locate: async () => null,
	scroll: async () => null,
	tabState: async () => null,
	allSites: async () => true,
	leadsTo: () => null,
	changes: () => 0,
	watch: () => () => {},
	opened: () => () => [],
	close: async () => true,
	switchBack: async () => null,
	capture: async () => {
		throw new Error("No capture in this test");
	},
	encode: async () => ({ data: "", width: 0, height: 0 }),
};

/** `config.current`: the settings as they are now; `attach()` gives the Harness whose transcript the hook reads. */
export function pageDeps(access: PageAccess, config: { current: PageToolSettings }, changed: () => void = () => {}) {
	let harness: Harness | undefined;
	const asks = new Asks(changed);
	const deps: PageDeps = {
		access,
		settings: async () => config.current,
		currentSettings: () => config.current,
		groups: { scope: async (anchor) => [{ id: anchor, groupId: -1, windowId: 1 }], group: async () => null },
		binding: () => undefined,
		browserSession: () => "test-browser-session",
		asks,
		async entries(conversationId, cursor, context) {
			const conversation = await harness?.conversation(conversationId, context);
			if (conversation === undefined) throw new Error("The chat is not open");
			return conversation.entries({ order: "descending" }, 50, cursor, context);
		},
		async context(conversationId, context) {
			const conversation = await harness?.conversation(conversationId, context);
			if (conversation === undefined) throw new Error("The chat is not open");
			return (await conversation.context(context)).messages;
		},
		captures: new CaptureQueue(),
	};
	return {
		deps,
		asks,
		attach(opened: Harness) {
			harness = opened;
		},
	};
}
