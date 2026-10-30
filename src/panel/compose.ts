import type { AttachedPage, Draft } from "../shared/protocol.ts";

/**
 * The page a typed message attaches. `draft`: the composer's draft while what it brought goes with the text. A page
 * prompt's draft attaches its own page, never the tab's newer one (design 6.18); a quote names its own page, so none is
 * attached. Otherwise the tab's page, unless the user detached pages at `detachedAt`. Detaching covers every page
 * captured before it, also one shown only later: the tab's page loads after the panel connects.
 */
export function attachedPage(
	page: AttachedPage | null,
	detachedAt: number | undefined,
	draft: Pick<Draft, "selection" | "page"> | null,
): AttachedPage | null {
	if (draft?.page != null) return draft.page;
	if (page === null || page.documentId === null || draft?.selection != null) return null;
	return detachedAt !== undefined && page.capturedAt <= detachedAt ? null : page;
}
