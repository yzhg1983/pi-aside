import { cut, MAX_URL_CHARS, pageTitle } from "../shared/protocol.ts";

/** Native metadata only. Missing titles and URLs stay unknown without the tabs permission. */
export type ScopeTab = { id: number; windowId: number; groupId: number; title?: string; url?: string };
export type TabGroups = {
	scope(anchor: number, check?: () => void): Promise<ScopeTab[]>;
	/** Best effort, after attribution. check() runs before each native request, including after every wait. */
	group(anchor: number, source: number, opened: number[], check: () => void): Promise<string | null>;
};
export const SCOPE_DENIED =
	"Cannot use this tab: the attached tab is missing, its native group could not be checked, or the target is outside its current group.";
export class ScopeDenied extends Error {
	constructor() {
		super(SCOPE_DENIED);
	}
}
const same = (a: chrome.tabs.Tab, b: chrome.tabs.Tab) => a.windowId === b.windowId && a.groupId === b.groupId;
const member = (anchor: chrome.tabs.Tab, tab: chrome.tabs.Tab) =>
	anchor.id === tab.id || (anchor.groupId !== -1 && same(anchor, tab));

export const chromeTabGroups: TabGroups = {
	async scope(anchorId, check) {
		check?.();
		const anchor = await chrome.tabs.get(anchorId).catch(() => {
			throw new ScopeDenied();
		});
		check?.();
		if (anchor.id !== anchorId) throw new ScopeDenied();
		const tabs =
			anchor.groupId === -1
				? [anchor]
				: await chrome.tabs.query({ groupId: anchor.groupId, windowId: anchor.windowId }).catch(() => {
						throw new ScopeDenied();
					});
		check?.();
		// A missing anchor in the query is not a usable group snapshot.
		if (!tabs.some((tab) => tab.id === anchorId)) throw new ScopeDenied();
		return tabs
			.filter((tab) => tab.id !== undefined && member(anchor, tab))
			.sort((a, b) => a.id! - b.id!)
			.map((tab) => ({
				id: tab.id!,
				windowId: tab.windowId,
				groupId: tab.groupId,
				...(tab.title === undefined ? {} : { title: pageTitle(tab.title) }),
				...(tab.url === undefined ? {} : { url: cut(tab.url, MAX_URL_CHARS) }),
			}));
	},
	async group(anchorId, sourceId, opened, check) {
		if (opened.length === 0) return null;
		try {
			check();
			const anchor = await chrome.tabs.get(anchorId);
			check();
			const source = await chrome.tabs.get(sourceId);
			if (anchor.pinned)
				return "Grouping skipped: the attached tab is pinned; opened tabs remain open and may be outside scope.";
			if (!member(anchor, source))
				return "Grouping skipped: source membership changed; opened tabs may be outside scope.";
			// One final native snapshot validates all participants together. No more preparatory awaits before group().
			check();
			const snapshot = await chrome.tabs.query({ windowId: anchor.windowId });
			const nowAnchor = snapshot.find((tab) => tab.id === anchorId);
			const nowSource = snapshot.find((tab) => tab.id === sourceId);
			if (
				nowAnchor === undefined ||
				nowSource === undefined ||
				nowAnchor.pinned ||
				!same(anchor, nowAnchor) ||
				!same(source, nowSource) ||
				!member(nowAnchor, nowSource)
			)
				return "Grouping skipped: source or anchor membership changed; opened tabs may be outside scope.";
			const candidates: number[] = [];
			let skipped = false;
			for (const id of new Set(opened)) {
				const tab = snapshot.find((tab) => tab.id === id);
				if (tab === undefined || tab.pinned || tab.windowId !== nowAnchor.windowId) {
					skipped = true;
					continue;
				}
				if (nowAnchor.groupId !== -1 && tab.groupId === nowAnchor.groupId) continue;
				if (tab.groupId !== -1) {
					skipped = true;
					continue;
				}
				candidates.push(id);
			}
			if (candidates.length > 0) {
				check();
				if (anchor.groupId === -1) {
					const groupId = await chrome.tabs.group({
						tabIds: [anchorId, ...candidates],
						createProperties: { windowId: anchor.windowId },
					});
					check();
					await chrome.tabGroups.update(groupId, { title: "pi" });
				} else
					await chrome.tabs.group({ tabIds: [candidates[0]!, ...candidates.slice(1)], groupId: anchor.groupId });
			}
			return skipped ? "Some opened tabs remain outside scope (pinned, another window or group)." : null;
		} catch {
			return "pi could not group the opened tabs; they remain open and may be outside scope.";
		}
	},
};
