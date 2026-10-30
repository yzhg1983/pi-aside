// A link to a time in the page a tab shows (design 6.38): `…/watch?v=ID&t=754s` or `…#t=754`. The panel plays such
// a link in the tab instead of opening it, so a timestamp in an answer moves the tab's video.

const TIME = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/;

/** The time `t` of a link, from its query or its fragment (`#t=754`), in seconds; null without one. */
export function linkTime(href: string): number | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const value = url.searchParams.get("t") ?? new URLSearchParams(url.hash.slice(1)).get("t");
	const match = value === null || value === "" ? null : TIME.exec(value);
	if (match === null) return null;
	const [, hours = "0", minutes = "0", seconds = "0"] = match;
	return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * The time to play `href` at in the page `pageUrl`, or null when it is not a link to that page at a time: the same
 * origin and path, and every query parameter of the link but `t` the same in the page, so a link that leaves out the
 * page's other parameters (`&list=…`) still matches. The fragment is not compared.
 */
export function timeInPage(href: string, pageUrl: string): number | null {
	const time = linkTime(href);
	if (time === null) return null;
	let link: URL;
	let page: URL;
	try {
		link = new URL(href);
		page = new URL(pageUrl);
	} catch {
		return null;
	}
	if (link.origin !== page.origin || link.pathname !== page.pathname) return null;
	for (const name of new Set(link.searchParams.keys())) {
		if (name === "t") continue;
		const want = link.searchParams.getAll(name);
		const have = page.searchParams.getAll(name);
		if (want.length !== have.length || want.some((value, i) => value !== have[i])) return null;
	}
	return time;
}
