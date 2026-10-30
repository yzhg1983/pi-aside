import { expect, it } from "vitest";
import { MAX_KEY_CHARS, urlKey } from "../src/background/url-key.ts";

it("lowercases scheme and host, drops the default port, credentials, and tracking parameters in any case", () => {
	expect(urlKey("HTTPS://user:pw@Example.com:443/Post?utm_source=mail&id=7&b=2&FBCLID=x&Utm_Medium=y", null)).toBe(
		"https://example.com/Post?b=2&id=7",
	);
	expect(urlKey("http://example.com:8080/a?gclid=1&_GL=2&mc_cid=3", null)).toBe("http://example.com:8080/a");
});

it("sorts parameters by name and keeps the order of one name's values", () => {
	expect(urlKey("https://example.com/s?z=1&a=2&z=0&a=1", null)).toBe("https://example.com/s?a=2&a=1&z=1&z=0");
	expect(urlKey("https://example.com/watch?v=1", null)).not.toBe(urlKey("https://example.com/watch?v=2", null));
});

it("drops a text directive, alone or after an app fragment", () => {
	expect(urlKey("https://example.com/post#:~:text=claim", null)).toBe("https://example.com/post");
	expect(urlKey("https://mail.google.com/mail/u/0/#inbox/FMfcg42:~:text=claim", false)).toBe(
		"https://mail.google.com/mail/u/0/#inbox/FMfcg42",
	);
});

it("drops a fragment the page has as an anchor, and keeps an app's or an unchecked one", () => {
	expect(urlKey("https://example.com/post#methods", true)).toBe("https://example.com/post");
	expect(urlKey("https://example.com/post#methods", false)).toBe("https://example.com/post#methods");
	expect(urlKey("https://example.com/post#methods", null)).toBe("https://example.com/post#methods");
	expect(urlKey("https://mail.google.com/mail/u/0/#inbox/FMfcg42", false)).toBe(
		"https://mail.google.com/mail/u/0/#inbox/FMfcg42",
	);
	expect(urlKey("https://example.com/post#", null)).toBe("https://example.com/post");
});

it("has no key for other schemes, URLs that do not parse, and keys over the limit", () => {
	expect(urlKey("chrome://newtab/", null)).toBeNull();
	expect(urlKey("file:///tmp/a.html", null)).toBeNull();
	expect(urlKey("about:blank", null)).toBeNull();
	expect(urlKey("not a url", null)).toBeNull();
	const base = "https://example.com/";
	expect(urlKey(`${base}${"a".repeat(MAX_KEY_CHARS - base.length)}`, null)).toHaveLength(MAX_KEY_CHARS);
	expect(urlKey(`${base}${"a".repeat(MAX_KEY_CHARS - base.length + 1)}`, null)).toBeNull();
	// Tracking parameters do not count toward the limit.
	expect(urlKey(`${base}a?utm_source=${"x".repeat(MAX_KEY_CHARS)}`, null)).toBe(`${base}a`);
});
