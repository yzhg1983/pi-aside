import { expect, it } from "vitest";
import {
	attached,
	checkAttachments,
	fileName,
	isDocument,
	MAX_FILE_CHARS,
	storedAttachments,
	textOf,
	withAttachments,
} from "../src/shared/attachments.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const IMAGE = { kind: "image", width: 4, height: 3, image: { mimeType: "image/png", data: "AAAA" } };

it("a text file is UTF-8 without NUL; documents are known by their start, also when their bytes are ASCII (design 6.42)", () => {
	expect(textOf("a.csv", bytes("name,total\nÄpfel,3\n"))).toEqual({ text: "name,total\nÄpfel,3\n" });
	// A PDF written in ASCII decodes as text: its signature refuses it.
	expect(textOf("a.pdf", bytes("%PDF-1.4\n1 0 obj << >> endobj\n"))).toEqual({
		error: "a.pdf is not an image or a text file: pi attaches only those.",
	});
	expect(isDocument(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]))).toBe(true);
	expect(isDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(true);
	expect(isDocument(bytes("PK is a name"))).toBe(false);
	expect(textOf("a.bin", new Uint8Array([0x61, 0xff, 0x62]))).toHaveProperty("error");
	expect(textOf("a.txt", bytes("a\0b"))).toHaveProperty("error");
	expect(textOf("a.txt", bytes("x".repeat(MAX_FILE_CHARS)))).toEqual({ text: "x".repeat(MAX_FILE_CHARS) });
	expect(textOf("big.txt", bytes("x".repeat(MAX_FILE_CHARS + 1)))).toEqual({
		error: "big.txt is longer than 100,000 characters.",
	});
	expect(fileName("  two\nlines.txt ")).toBe("two lines.txt");
	expect(fileName("")).toBe("file");
});

it("the worker checks a send's attachments again: number, shape, and the files' characters in all", () => {
	const file = (chars: number) => ({ kind: "file", name: "f.txt", text: "x".repeat(chars) });
	expect(checkAttachments([IMAGE, file(3)])).toEqual([IMAGE, file(3)]);
	expect(() => checkAttachments(undefined)).toThrow("An attachment is not valid");
	expect(() => checkAttachments(Array.from({ length: 11 }, () => file(1)))).toThrow("at most 10 attachments");
	expect(() => checkAttachments([file(MAX_FILE_CHARS), file(MAX_FILE_CHARS), file(1)])).toThrow(
		"200,000 characters in all",
	);
	for (const bad of [
		{ ...IMAGE, width: 1281 },
		{ ...IMAGE, height: 0 },
		{ ...IMAGE, image: { mimeType: "image/gif", data: "AAAA" } },
		{ ...IMAGE, image: { mimeType: "image/png", data: "not base64!" } },
		{ ...IMAGE, image: { mimeType: "image/png", data: "A".repeat(500_001) } },
		{ kind: "file", name: "f.txt", text: "a\0" },
		{ kind: "file", name: 1, text: "" },
		{ kind: "other" },
		null,
	])
		expect(() => checkAttachments([bad])).toThrow();
	// A name is kept on one line.
	expect(checkAttachments([{ kind: "file", name: "a\nb", text: "" }])).toEqual([
		{ kind: "file", name: "a b", text: "" },
	]);
});

it("an input's content is its text, then one block per attachment; its data names them only when they match", () => {
	const { infos, blocks } = attached(checkAttachments([{ kind: "file", name: "n.txt", text: "hi" }, IMAGE]));
	expect(withAttachments("Look", [])).toBe("Look");
	const content = withAttachments("Look", blocks);
	expect(content).toEqual([
		{ type: "text", text: "Look" },
		{ type: "text", text: '[Attached file: "n.txt", 2 characters]\nhi\n[End of file "n.txt"]' },
		{ type: "image", mimeType: "image/png", data: "AAAA" },
	]);
	expect(storedAttachments({ text: "Look", attachments: infos }, content)).toEqual({
		lead: "Look",
		attachments: infos,
		blocks,
	});
	// No lead: the attachments alone.
	expect(withAttachments("", blocks)).toEqual(blocks);
	expect(storedAttachments({ attachments: infos }, blocks)?.lead).toBe("");
	// Entries from before attachments, and data that does not match its content, show as plain text.
	expect(storedAttachments({ text: "Look" }, content)).toBeUndefined();
	expect(storedAttachments({ attachments: infos }, "Look")).toBeUndefined();
	expect(storedAttachments({ attachments: infos }, [blocks[1]!, blocks[0]!])).toBeUndefined();
	expect(
		storedAttachments({ attachments: infos }, [{ type: "text", text: "a" }, { type: "text", text: "b" }, ...blocks]),
	).toBeUndefined();
	expect(storedAttachments({ attachments: [{ kind: "file" }] }, [blocks[0]!])).toBeUndefined();
});
