// run_script's runner (design 6.23), here in Node: a lone expression or a function body, its own console, errors, and
// the bound on the result's JSON. In Chrome it runs in pi's script world (e2e).

import { expect, it } from "vitest";
import { runScript, type ScriptResult } from "../src/background/script-runner.ts";

const MAX = 40 * 1024;
const run = async (code: string, maxBytes = MAX) => {
	const text = await runScript(code, maxBytes);
	return { result: JSON.parse(text) as ScriptResult, bytes: new TextEncoder().encode(text).length };
};

it("returns a lone expression's value, also with a trailing semicolon or line comment, and runs anything else as a function body", async () => {
	expect((await run("1 + 1")).result).toEqual({ ok: true, value: 2, logs: [] });
	expect((await run("'a' + 'b';  \n")).result).toEqual({ ok: true, value: "ab", logs: [] });
	expect((await run("[1, 2].length // the count")).result).toEqual({ ok: true, value: 2, logs: [] });
	expect((await run("await Promise.resolve({ a: 1 })")).result).toEqual({ ok: true, value: { a: 1 }, logs: [] });
	expect((await run("const a = 2;\nreturn a * 3;")).result).toEqual({ ok: true, value: 6, logs: [] });
	expect((await run("let n = 0; n += 1;")).result).toEqual({ ok: true, value: null, logs: [] });
	// An expression that throws is not run again as a body.
	const before = (globalThis as { runs?: number }).runs;
	const thrown = await run("(globalThis.runs = (globalThis.runs ?? 0) + 1, missing.x)");
	expect(thrown.result).toMatchObject({ ok: false, error: { name: "ReferenceError" } });
	expect((globalThis as { runs?: number }).runs).toBe((before ?? 0) + 1);
});

it("gives the code a console of its own and reports errors with name, message, and stack", async () => {
	const { result } = await run(
		"console.log('one', 2, { a: [1] }); console.warn('careful'); console.error(new Error('bad')); console.time('t'); return 7",
	);
	expect(result).toEqual({
		ok: true,
		value: 7,
		logs: ['one 2 {"a":[1]}', "warn: careful", "error: Error: bad"],
	});
	expect((await run("console.log('before'); throw new TypeError('nope')")).result).toMatchObject({
		ok: false,
		error: { name: "TypeError", message: "nope", stack: expect.stringContaining("TypeError: nope") },
		logs: ["before"],
	});
	expect((await run("throw 'plain'")).result).toEqual({
		ok: false,
		error: { name: "Thrown", message: "plain", stack: null },
		logs: [],
	});
	expect((await run("return )")).result).toMatchObject({ ok: false, error: { name: "SyntaxError" } });
	expect((await run("await new Promise((_, reject) => reject(new RangeError('late')))")).result).toMatchObject({
		ok: false,
		error: { name: "RangeError", message: "late" },
	});
});

it("returns JSON values: undefined and NaN as null, bigint as text, a Map or a Set as an array, a cycle marked", async () => {
	const { result } = await run(`
		const loop = { name: "loop" };
		loop.self = loop;
		return {
			none: undefined,
			nan: NaN,
			big: 10n,
			map: new Map([["k", 1]]),
			set: new Set([1, 2]),
			date: new Date(0),
			loop,
			list: [undefined, () => 1],
		};
	`);
	expect(result).toEqual({
		ok: true,
		value: {
			nan: null,
			big: "10",
			map: [["k", 1]],
			set: [1, 2],
			date: "1970-01-01T00:00:00.000Z",
			loop: { name: "loop", self: "[Circular]" },
			list: [null, null],
		},
		logs: [],
	});
	expect((await run("undefined")).result).toEqual({ ok: true, value: null, logs: [] });
});

it("keeps booleans, also nested and in logs, and a __proto__ key as a property", async () => {
	expect((await run("true")).result).toEqual({ ok: true, value: true, logs: [] });
	expect((await run("false")).result).toEqual({ ok: true, value: false, logs: [] });
	const { result } = await run(
		"console.log(true, { ready: false }); return { success: true, rejected: false, list: [true, false] }",
	);
	expect(result).toEqual({
		ok: true,
		value: { success: true, rejected: false, list: [true, false] },
		logs: ['true {"ready":false}'],
	});
	const text = await runScript(`JSON.parse('{"__proto__":{"kept":1},"ordinary":2}')`, MAX);
	expect(text).toBe('{"ok":true,"value":{"__proto__":{"kept":1},"ordinary":2},"logs":[]}');
});

it("reports a thrown value whose name getter or prototype throws, with the logs", async () => {
	const getter = await run(`
		console.log("before");
		const error = new Error("original");
		Object.defineProperty(error, "name", { get() { throw new Error("name getter"); } });
		throw error;
	`);
	// V8 builds the stack text on first read, with the name: here it is null.
	expect(getter.result).toMatchObject({ ok: false, error: { name: "Error", message: "original" }, logs: ["before"] });
	const proxy = await run(`
		console.log("before");
		throw new Proxy({}, { getPrototypeOf() { throw new Error("prototype trap"); } });
	`);
	expect(proxy.result).toMatchObject({ ok: false, error: { name: "Thrown", stack: null }, logs: ["before"] });
});

it("keeps the whole result within its bound: a long value, many logs, and deep nesting are cut and marked", async () => {
	const long = await run("'x'.repeat(100_000)");
	expect(long.bytes).toBeLessThanOrEqual(MAX);
	expect(long.result).toMatchObject({ ok: true, truncated: true });
	expect((long.result as { value: string }).value.length).toBeGreaterThan(30_000);

	const wide = await run("Array.from({ length: 100_000 }, (_, i) => ({ i, text: 'é'.repeat(20) }))");
	expect(wide.bytes).toBeLessThanOrEqual(MAX);
	expect(wide.result).toMatchObject({ ok: true, truncated: true });

	// Scalars that use up the room: the arrays and the object are cut, and marked.
	for (const code of [
		"Array.from({ length: 10000 }, (_, i) => i)",
		"Array(10000).fill(true)",
		"Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['element' + i, true]))",
	]) {
		const cut = await run(code);
		expect(cut.bytes).toBeLessThanOrEqual(MAX);
		expect(cut.result).toMatchObject({ ok: true, truncated: true });
	}

	const logged = await run(
		"for (let i = 0; i < 10_000; i++) console.log('line', i, '\u0001'.repeat(10)); return 'end'",
	);
	expect(logged.bytes).toBeLessThanOrEqual(MAX);
	expect(logged.result).toMatchObject({ ok: true, value: "end", truncated: true });
	expect(logged.result.logs.length).toBeGreaterThan(100);

	const deep = await run(
		"let o = {}; const top = o; for (let i = 0; i < 1000; i++) { o.next = {}; o = o.next } return top",
	);
	expect(deep.bytes).toBeLessThanOrEqual(MAX);
	expect(deep.result).toMatchObject({ ok: true, truncated: true });

	const thrown = await run("console.log('y'.repeat(30_000)); throw new Error('z'.repeat(30_000))");
	expect(thrown.bytes).toBeLessThanOrEqual(MAX);
	expect(thrown.result).toMatchObject({ ok: false, truncated: true });
});

it("runs from its source text alone, as Chrome gets it", async () => {
	const source = `(${runScript.toString()})(${JSON.stringify("return document")}, ${MAX})`;
	// No module scope: the source is evaluated where only globals exist.
	const evaluate = (text: string) => new Function(`return ${text}`)() as Promise<string>;
	expect(JSON.parse(await evaluate(source))).toMatchObject({ ok: false, error: { name: "ReferenceError" } });
	const list = await evaluate(`(${runScript.toString()})("[1, 'two']", ${MAX})`);
	expect(JSON.parse(list)).toEqual({ ok: true, value: [1, "two"], logs: [] });
});
