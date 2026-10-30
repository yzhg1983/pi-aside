// Run by test/wait-on-page.test.ts in a child process. Sends the input in argv[3] to a new chat in the database at
// argv[2]; the model waits on the page's medium for 300 s, and the process exits at the wait's second check, after its
// start was kept, as when Chrome stops the worker.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Input } from "../../src/background/chats.ts";
import { WAIT_ON_PAGE } from "../../src/background/page.ts";
import { pageExtension } from "../../src/background/page-tools.ts";
import { ALL_ON, pageDeps } from "./page-deps.ts";
import { memoryStore, openChats } from "./tabs.ts";
import { waitPage } from "./wait-page.ts";

const context = BACKGROUND_CONTEXT;
const [path, input] = process.argv.slice(2);
setTimeout(() => process.exit(1), 10_000).unref();

const { access, calls } = waitPage(1_000_000);
const media = access.media;
access.media = async (...args) => {
	if (calls.media.length === 1) process.exit(0);
	return media(...args);
};
const registry = createRegistry();
const { deps, attach } = pageDeps(access, { current: ALL_ON });
registry.install(pageExtension(deps, ALL_ON));
const faux = fauxProvider({ provider: "openrouter", models: [{ id: "one" }] });
faux.setResponses([
	fauxAssistantMessage(fauxToolCall(WAIT_ON_PAGE, { until: { media: { from: 0, to: 500 } }, timeoutSec: 300 }), {
		stopReason: "toolUse",
	}),
]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(await openNodeSqliteStorage(path!), { models, registry }, context);
attach(harness);
const { chats } = await openChats(
	harness,
	{ store: memoryStore().store, open: new Set([1]) },
	{
		admit: (operation) => operation(),
		check: async () => {},
		imageLimit: async () => 20,
		defaultModel: async () => ({ provider: "openrouter", modelId: "one" }),
		setDefaultModel: async () => {},
		thinking: async () => "off",
		changed: () => {},
	},
);
harness.resume();
await chats.send(1, 0, null, JSON.parse(input!) as Input, null);
