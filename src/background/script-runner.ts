// The part of run_script that runs in the page (design 6.23): `runScript` runs the model's code in pi's own
// `USER_SCRIPT` world and gives back its result as JSON text. Self-contained: the worker sends its source.

export type ScriptError = { name: string; message: string; stack: string | null };

/** `truncated`: part of the value or of the logs was left out, to keep the result's JSON within its bound. */
export type ScriptResult =
	| { ok: true; value: unknown; logs: string[]; truncated?: true }
	| { ok: false; error: ScriptError; logs: string[]; truncated?: true };

/**
 * Runs `code` as one expression, if it compiles as one without a trailing `;`, or else as the body of an async
 * function, with a `console` of its own. Resolves to the `ScriptResult` as JSON text, of at most `maxBytes` (UTF-8):
 * a string keeps its values exact through Chrome, which leaves out null properties of objects it passes.
 */
export async function runScript(code: string, maxBytes: number): Promise<string> {
	const encoder = new TextEncoder();
	const bytes = (text: string) => encoder.encode(text).length;
	const MAX_DEPTH = 100;
	const MAX_VISITS = 100_000;
	const MAX_ERROR = 4_000;
	let truncated = false;

	/** `text`, cut so that its JSON takes at most `room` bytes. */
	const cutTo = (text: string, room: number): string => {
		if (bytes(JSON.stringify(text)) <= room) return text;
		truncated = true;
		let end = Math.max(0, Math.min(text.length, room - 2));
		let kept = text.slice(0, end).toWellFormed();
		while (end > 0 && bytes(JSON.stringify(kept)) > room) {
			end = Math.floor(end * 0.9);
			kept = text.slice(0, end).toWellFormed();
		}
		return kept;
	};

	/**
	 * A copy of `value` that JSON keeps as it is, within about `budget.left` bytes: DOM nodes as "<TAG>", a Map or a Set
	 * as an array, a cycle as "[Circular]". Undefined where JSON leaves the value out.
	 */
	const copy = (value: unknown, budget: { left: number; visits: number }, parents: object[]): unknown => {
		if (budget.left <= 0 || --budget.visits < 0) {
			truncated = true;
			return undefined;
		}
		switch (typeof value) {
			case "string": {
				const kept = cutTo(value, budget.left);
				budget.left -= bytes(JSON.stringify(kept));
				return kept;
			}
			case "boolean":
				budget.left -= 5;
				return value;
			case "number":
			case "bigint": {
				const shown = typeof value === "bigint" ? String(value) : Number.isFinite(value) ? value : null;
				budget.left -= String(shown).length + 2;
				return shown;
			}
			case "object":
				break;
			default:
				return undefined;
		}
		if (value === null) {
			budget.left -= 4;
			return null;
		}
		if (typeof Node === "function" && value instanceof Node) return copy(`<${value.nodeName}>`, budget, parents);
		if (parents.includes(value)) return copy("[Circular]", budget, parents);
		if (parents.length >= MAX_DEPTH) {
			truncated = true;
			return undefined;
		}
		const inner = [...parents, value];
		const json = (value as { toJSON?: unknown }).toJSON;
		if (typeof json === "function") return copy(json.call(value), budget, inner);
		const list = Array.isArray(value)
			? value
			: value instanceof Map
				? [...value.entries()]
				: value instanceof Set
					? [...value]
					: null;
		if (list !== null) {
			const out: unknown[] = [];
			budget.left -= 2;
			for (const item of list) {
				const kept = copy(item, budget, inner);
				// The item and the rest are left out.
				if (budget.left <= 0 || budget.visits < 0) {
					truncated = true;
					break;
				}
				out.push(kept === undefined ? null : kept);
				budget.left -= 1;
			}
			return out;
		}
		// Without a prototype, a key such as "__proto__" is an own property like any other.
		const out: Record<string, unknown> = Object.create(null);
		budget.left -= 2;
		for (const key of Object.keys(value)) {
			let item: unknown;
			try {
				item = (value as Record<string, unknown>)[key];
			} catch {
				continue;
			}
			budget.left -= bytes(JSON.stringify(key)) + 2;
			const kept = copy(item, budget, inner);
			if (budget.left <= 0 || budget.visits < 0) {
				truncated = true;
				break;
			}
			if (kept !== undefined) out[key] = kept;
		}
		return out;
	};

	/** A logged or thrown value as text; it never throws. */
	const show = (value: unknown): string => {
		if (typeof value === "string") return value;
		try {
			if (value instanceof Error) return `${String(value.name)}: ${String(value.message)}`;
			const kept = copy(value, { left: 2_000, visits: 1_000 }, []);
			return kept === undefined ? String(value) : JSON.stringify(kept);
		} catch {
			return "(a value pi cannot show)";
		}
	};

	const logs: string[] = [];
	// Logs may take half of the result; the value takes what is left.
	let logRoom = Math.floor(maxBytes / 2);
	const line =
		(level: string) =>
		(...args: unknown[]) => {
			if (logRoom <= 0) {
				truncated = true;
				return;
			}
			const text = args.map(show).join(" ");
			const kept = cutTo(level === "" ? text : `${level}: ${text}`, logRoom);
			logRoom -= bytes(JSON.stringify(kept)) + 1;
			logs.push(kept);
		};
	// Every method of the real console is there; those that log write to `logs`, the others do nothing.
	const ownConsole: Record<string, (...args: unknown[]) => void> = {};
	for (const name of Object.keys(globalThis.console)) ownConsole[name] = () => {};
	Object.assign(ownConsole, {
		log: line(""),
		info: line("info"),
		debug: line("debug"),
		dir: line(""),
		table: line(""),
		warn: line("warn"),
		error: line("error"),
	});

	/** What the code threw; it never throws itself, also for getters or proxies that throw. */
	const errorOf = (thrown: unknown): ScriptError => {
		const read = (get: () => unknown): string | null => {
			try {
				const value = get();
				return value === undefined || value === null ? null : String(value);
			} catch {
				return null;
			}
		};
		let isError: boolean;
		try {
			isError = thrown instanceof Error;
		} catch {
			// A proxy whose getPrototypeOf throws.
			isError = false;
		}
		if (!isError) return { name: "Thrown", message: cutTo(show(thrown), MAX_ERROR), stack: null };
		const error = thrown as Error;
		const stack = read(() => error.stack);
		return {
			name: cutTo(read(() => error.name) ?? "Error", 200),
			message: cutTo(read(() => error.message) ?? "(a message pi cannot show)", MAX_ERROR),
			stack: stack === null ? null : cutTo(stack, MAX_ERROR),
		};
	};

	/** The result as JSON within `maxBytes`: the value takes the room the rest leaves. */
	const done = (result: ScriptResult, value?: unknown): string => {
		const flag = () => (truncated ? { truncated: true as const } : {});
		if (!result.ok) return JSON.stringify({ ...result, logs, ...flag() });
		const rest = bytes(JSON.stringify({ ok: true, value: null, logs, truncated: true }));
		for (let room = maxBytes - rest; room > 0; room = Math.floor(room / 2)) {
			let kept: unknown;
			try {
				kept = copy(value, { left: room, visits: MAX_VISITS }, []);
			} catch {
				// A getter or a proxy that throws: the script itself ran.
				kept = "(a value pi cannot show)";
			}
			const text = JSON.stringify({ ok: true, value: kept === undefined ? null : kept, logs, ...flag() });
			if (bytes(text) <= maxBytes) return text;
			truncated = true;
		}
		truncated = true;
		return JSON.stringify({ ok: true, value: null, logs, ...flag() });
	};

	try {
		type Run = (console: Record<string, (...args: unknown[]) => void>) => Promise<unknown>;
		const AsyncFunction = (async () => {}).constructor as new (param: string, body: string) => Run;
		let end = code.length;
		while (end > 0 && /[\s;]/.test(code.charAt(end - 1))) end--;
		let run: Run;
		try {
			// The newlines keep a trailing line comment from taking the parenthesis.
			run = new AsyncFunction("console", `return (\n${code.slice(0, end)}\n)`);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			run = new AsyncFunction("console", code);
		}
		const value = await run(ownConsole);
		return done({ ok: true, value: null, logs }, value);
	} catch (error) {
		return done({ ok: false, error: errorOf(error), logs });
	}
}
