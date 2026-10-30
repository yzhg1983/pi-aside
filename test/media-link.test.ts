import { expect, it } from "vitest";
import { linkTime, timeInPage } from "../src/shared/media-link.ts";

it("reads a time from the query or the fragment, in seconds or with h, m, s", () => {
	expect(linkTime("https://www.youtube.com/watch?v=abc&t=754s")).toBe(754);
	expect(linkTime("https://www.youtube.com/watch?v=abc&t=754")).toBe(754);
	expect(linkTime("https://www.youtube.com/watch?v=abc&t=1h2m3s")).toBe(3723);
	expect(linkTime("https://www.youtube.com/watch?v=abc&t=12m")).toBe(720);
	expect(linkTime("https://example.com/talk.mp4#t=90.5")).toBe(90.5);
	expect(linkTime("https://vimeo.com/123#t=45s")).toBe(45);
});

it("finds no time without one, or with one it cannot read", () => {
	expect(linkTime("https://www.youtube.com/watch?v=abc")).toBeNull();
	expect(linkTime("https://www.youtube.com/watch?v=abc&t=")).toBeNull();
	expect(linkTime("https://www.youtube.com/watch?v=abc&t=soon")).toBeNull();
	expect(linkTime("https://example.com/talk.mp4#t=10,20")).toBeNull();
	expect(linkTime("not a url")).toBeNull();
});

it("plays a link to the page the tab shows, also when the link leaves out its other parameters", () => {
	const page = "https://www.youtube.com/watch?v=abc&list=PL1&index=3";
	expect(timeInPage("https://www.youtube.com/watch?v=abc&t=754s", page)).toBe(754);
	expect(timeInPage("https://www.youtube.com/watch?v=abc&list=PL1&t=754s", page)).toBe(754);
	expect(timeInPage("https://www.youtube.com/watch?t=754s&v=abc", "https://www.youtube.com/watch?v=abc&t=30s")).toBe(
		754,
	);
	expect(timeInPage("https://example.com/talk#t=90", "https://example.com/talk")).toBe(90);
});

it("does not play a link to another page", () => {
	const page = "https://www.youtube.com/watch?v=abc";
	expect(timeInPage("https://www.youtube.com/watch?v=xyz&t=754s", page)).toBeNull();
	expect(timeInPage("https://m.youtube.com/watch?v=abc&t=754s", page)).toBeNull();
	expect(timeInPage("https://www.youtube.com/shorts/abc?t=5", page)).toBeNull();
	expect(timeInPage("https://www.youtube.com/watch?v=abc&list=PL2&t=754s", page)).toBeNull();
	expect(timeInPage("https://www.youtube.com/watch?v=abc", page)).toBeNull();
});
