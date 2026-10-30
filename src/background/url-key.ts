// The key that finds a page's chat again (design 6.17): two URLs of the same page get the same key, so a page opened
// in a new tab, or after a restart, continues the chat that started there.

/** Ad and email click IDs, compared lowercase. Names that start with `utm_` are dropped too. */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
	"fbclid",
	"gclid",
	"gclsrc",
	"dclid",
	"gbraid",
	"wbraid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"li_fat_id",
	"igshid",
	"mc_cid",
	"mc_eid",
	"_hsenc",
	"_hsmi",
	"mkt_tok",
	"_ga",
	"_gl",
]);

/** A longer key is no key: a cut could make two pages match. */
export const MAX_KEY_CHARS = 2048;

/**
 * The key of the full top-level URL `url`, or null for a URL that is not http(s) or does not parse. `anchor`: whether
 * the capture found an element with the fragment's ID or anchor name in the page; true drops the fragment as a place in
 * the page, false and null (unknown) keep it as the app's state. Chrome's text directive (`:~:`) is always dropped.
 */
export function urlKey(url: string, anchor: boolean | null): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	// `origin` has the lowercase scheme and host, without the default port, the user name, and the password.
	let fragment = parsed.hash.slice(1);
	const directive = fragment.indexOf(":~:");
	if (directive >= 0) fragment = fragment.slice(0, directive);
	const params = new URLSearchParams(
		[...parsed.searchParams].filter(([name]) => {
			const lower = name.toLowerCase();
			return !lower.startsWith("utm_") && !TRACKING_PARAMS.has(lower);
		}),
	);
	// Stable, by UTF-16 code units: the values of one name keep their order.
	params.sort();
	const search = params.toString();
	const key = `${parsed.origin}${parsed.pathname}${search === "" ? "" : `?${search}`}${fragment === "" || anchor === true ? "" : `#${fragment}`}`;
	return key.length > MAX_KEY_CHARS ? null : key;
}
