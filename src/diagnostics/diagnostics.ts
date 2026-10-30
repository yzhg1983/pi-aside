// Diagnostics page: worker status, the log, and the phase 0 probes. The long prompt goes to the chat of the tab whose
// panel opened this page (`?tab=<id>`); without one, it cannot send or stop.

import { pageTab, WorkerClient } from "../panel/client.ts";
import { type PanelState, PROVIDERS, type ProviderId } from "../shared/protocol.ts";

const LONG_PROMPT =
	"Write a detailed essay of about 2000 words on the history of the printing press, with section headings. " +
	"Do not use tools.";

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`missing #${id}`);
	return found as T;
}

const ui = {
	connection: element("connection"),
	status: element("status"),
	long: element<HTMLButtonElement>("long"),
	abort: element<HTMLButtonElement>("abort"),
	conformance: element<HTMLButtonElement>("conformance"),
	keepalive: element<HTMLInputElement>("keepalive"),
	clearLog: element<HTMLButtonElement>("clear-log"),
	reload: element<HTMLButtonElement>("reload"),
	log: element("log"),
};

let state: PanelState | undefined;

const tabId = pageTab(location.search);
const client = new WorkerClient({
	tabId,
	log: true,
	onState: render,
	onConnection: (connection) => {
		ui.connection.className = `dot ${connection === "connected" ? "ok" : connection === "incompatible" ? "bad" : ""}`;
		ui.connection.title = connection;
	},
});

function render(next: PanelState): void {
	state = next;
	const { status, chat } = next;
	const rows: [string, string][] = [
		["boot", String(status.boot)],
		["worker up", `${Math.round((Date.now() - status.workerStartedAt) / 1000)} s`],
		["harness open", status.harnessError ?? (status.harnessOpenMs === null ? "-" : `${status.harnessOpenMs} ms`)],
		["storage full", status.storageFull ? "yes" : "no"],
		[
			"access",
			(Object.keys(PROVIDERS) as ProviderId[])
				.map(
					(p) =>
						`${p} key ${status.access[p].key ? "set" : "-"}, permission ${status.access[p].permission ? "yes" : "-"}`,
				)
				.join("; "),
		],
		[
			"wake",
			status.wake === null
				? "unknown"
				: `active: ${status.wake.active}; at: ${status.wake.at === null ? "-" : new Date(status.wake.at).toISOString()}`,
		],
		["keepalive", `${status.keepalive ? "running" : "idle"}${status.keepaliveEnabled ? "" : " (disabled)"}`],
		[
			"chat",
			tabId === null
				? "no tab"
				: `tab ${tabId}: ${
						chat.conversationId === null
							? "none"
							: `${chat.conversationId}, ${chat.entries.length} entries${chat.busy ? ", busy" : ""}${chat.live ? `, attempt ${chat.live.attempt}` : ""}`
					}`,
		],
	];
	const attachment = status.attachment;
	if (attachment !== null) {
		rows.push(
			["capture", `${attachment.via} at ${new Date(attachment.capturedAt).toLocaleTimeString()}`],
			["page", `${attachment.title || "(untitled)"} - ${attachment.url || "(no url)"}`],
			["document", `${attachment.documentId ?? "-"} (tab ${attachment.tabId}, frame ${attachment.frameId})`],
			[
				"selection",
				attachment.selection === undefined
					? "none"
					: `${attachment.selection.length} chars via ${attachment.selectionSource}`,
			],
		);
		if (attachment.error) rows.push(["capture error", attachment.error]);
	}
	ui.status.replaceChildren(
		...rows.flatMap(([label, value]) => {
			const dt = document.createElement("dt");
			dt.textContent = label;
			const dd = document.createElement("dd");
			dd.textContent = value;
			return [dt, dd];
		}),
	);
	ui.keepalive.checked = status.keepaliveEnabled;
	ui.long.disabled = tabId === null;
	ui.abort.disabled = !chat.busy;
	const atBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 40;
	ui.log.textContent = next.log.join("\n");
	if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}

function report(operation: Promise<unknown>): Promise<void> {
	return operation.then(
		() => {},
		(error: Error) => {
			ui.log.textContent += `\n[diagnostics] ${error.message}`;
		},
	);
}

ui.long.addEventListener("click", () => {
	if (state === undefined) return;
	void report(
		client.request({
			type: "send",
			rev: state.rev,
			conversationId: state.chat.conversationId,
			requestId: crypto.randomUUID(),
			text: LONG_PROMPT,
			draftId: null,
			quote: false,
			page: null,
			whenBusy: "followUp",
			attachments: [],
		}),
	);
});

ui.abort.addEventListener("click", () => {
	if (state?.chat.busy) void report(client.request({ type: "abort", rev: state.rev }));
});

ui.conformance.addEventListener("click", () => {
	ui.conformance.disabled = true;
	void report(client.request({ type: "conformance" })).finally(() => {
		ui.conformance.disabled = false;
	});
});

ui.keepalive.addEventListener("change", () => {
	void report(client.request({ type: "set-keepalive", enabled: ui.keepalive.checked }));
});

ui.clearLog.addEventListener("click", () => void report(client.request({ type: "clear-log" })));
ui.reload.addEventListener("click", () => chrome.runtime.reload());

client.start();
