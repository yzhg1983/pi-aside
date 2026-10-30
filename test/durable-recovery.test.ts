import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { checkRestarts, MAX_AUTOMATIC_RECOVERIES, MAX_BACKGROUND_RECOVERIES } from "../src/background/breaker.ts";

const context = BACKGROUND_CONTEXT;
const sameSession = { newBrowserSession: false };

/** A background task, like a compaction, that runs until the Harness closes; counts its invocations. */
let hangStarts = 0;
let hangStarted = Promise.withResolvers<void>();
const Hang = defineTask<null, { phase: "wait" }, null>({
	name: "test.hang",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (_task, runtime) => {
			hangStarts += 1;
			hangStarted.resolve();
			await new Promise((_, reject) => runtime.signal.addEventListener("abort", () => reject(new Error("closed"))));
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	let requested = Promise.withResolvers<void>();
	// Every request hangs like a slow stream until closing the Harness aborts it.
	const hang = (_transcript: unknown, options?: { signal?: AbortSignal }) => {
		requested.resolve();
		return new Promise<never>((_, reject) => {
			options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")));
		});
	};
	faux.setResponses(Array.from({ length: 10 }, () => hang));
	const path = join(mkdtempSync(join(tmpdir(), "pi-aside-")), "session.sqlite");
	const registry = createRegistry();
	registry.install({ name: "test", tasks: [Hang] });
	return {
		faux,
		model: { provider: model.provider, modelId: model.id },
		open: async () => Harness.open(await openNodeSqliteStorage(path), { models, registry }, context),
		/** Resolves at the next provider request. */
		nextRequest: () => {
			requested = Promise.withResolvers<void>();
			return requested.promise;
		},
	};
}

// Phase 0 probe: pi-durable must not send another request for a run abort-marked before resume().
it("abortTask while scheduling is paused ends an interrupted run without a new request", async () => {
	const { faux, model, open, nextRequest } = setup();
	const first = await open();
	const root = await first.root(context, { agent: { model } });
	const request = nextRequest();
	const submission = await root.submit({ type: "input", content: "hello", requestId: "r1" }, context);
	await request;
	await first.close(context);

	const second = await open();
	const interrupted = await second.inspect(context);
	expect(interrupted.scheduling).toBe("paused");
	const generation = interrupted.tasks.find((task) => task.record.kind === "pi.generation");
	expect(generation).toBeDefined();

	await second.abortTask(generation!.record.id, context);
	expect((await second.inspect(context)).scheduling).toBe("paused");

	second.resume();
	const settled = await (await second.submission(submission.id, context))!.wait(context);
	expect(settled.status).toBe("unanswered");
	expect(faux.state.callCount).toBe(1);
	await second.close(context);
});

it("the restart breaker allows MAX_AUTOMATIC_RECOVERIES resumes of a run, then aborts it", async () => {
	const { faux, model, open, nextRequest } = setup();
	const first = await open();
	const root = await first.root(context, { agent: { model } });
	let request = nextRequest();
	const submission = await root.submit({ type: "input", content: "hello", requestId: "r1" }, context);
	await request;
	// An alarm on the running worker is not a restart: only checkRestarts() at worker start counts.
	await first.close(context);

	for (let restart = 1; restart <= MAX_AUTOMATIC_RECOVERIES; restart++) {
		const harness = await open();
		const decisions = await checkRestarts(harness, context, sameSession);
		expect(decisions).toEqual([
			{ key: String(submission.id), kind: "run", taskId: expect.anything(), recoveries: restart },
		]);
		request = nextRequest();
		harness.resume();
		await request;
		await harness.close(context);
	}
	expect(faux.state.callCount).toBe(1 + MAX_AUTOMATIC_RECOVERIES);

	const blocked = await open();
	const decisions = await checkRestarts(blocked, context, sameSession);
	expect(decisions).toMatchObject([{ kind: "run", blocked: "budget", recoveries: MAX_AUTOMATIC_RECOVERIES }]);
	blocked.resume();
	const settled = await (await blocked.submission(submission.id, context))!.wait(context);
	expect(settled.status).toBe("unanswered");
	expect(faux.state.callCount).toBe(1 + MAX_AUTOMATIC_RECOVERIES);

	// A retry is a new submission with a new request ID, and the finished run no longer counts.
	expect(await checkRestarts(blocked, context, sameSession)).toEqual([]);
	await blocked.close(context);
});

it("in a new browser session the breaker aborts the run and withdraws the inputs queued behind it", async () => {
	const { faux, model, open, nextRequest } = setup();
	const first = await open();
	const root = await first.root(context, { agent: { model } });
	const request = nextRequest();
	const asked = await root.submit({ type: "input", content: "hello", requestId: "r1" }, context);
	await request;
	const followUp = await root.submit({ type: "input", content: "and then?", requestId: "r2" }, context);
	const queued = (await first.inspect(context)).submissions.find((record) => record.id === followUp.id);
	expect(queued?.status).toBe("queued");
	await first.close(context);

	const second = await open();
	const decisions = await checkRestarts(second, context, { newBrowserSession: true });
	expect(decisions).toMatchObject([{ key: String(asked.id), kind: "run", blocked: "new browser session" }]);
	second.resume();
	for (const id of [asked.id, followUp.id]) {
		const settled = await (await second.submission(id, context))!.wait(context);
		expect(settled.status).toBe("unanswered");
	}
	// Without the withdrawal, the follow-up would start a new run and send a request now.
	await second.waitForIdle(context);
	expect(faux.state.callCount).toBe(1);
	expect((await second.inspect(context)).tasks).toEqual([]);
	await second.close(context);
});

it("aborts a run on a provider whose credential a removal deleted before stopping it, without counting a recovery", async () => {
	const { faux, model, open, nextRequest } = setup();
	const first = await open();
	const root = await first.root(context, { agent: { model } });
	const request = nextRequest();
	const asked = await root.submit({ type: "input", content: "hello", requestId: "r1" }, context);
	await request;
	const followUp = await root.submit({ type: "input", content: "and then?", requestId: "r2" }, context);
	await first.close(context);

	// A removal on another provider leaves the run to the breaker.
	const second = await open();
	expect(await checkRestarts(second, context, { ...sameSession, stopping: ["other"] })).toMatchObject([
		{ kind: "run", recoveries: 1 },
	]);
	await second.close(context);

	const third = await open();
	const decisions = await checkRestarts(third, context, { ...sameSession, stopping: [model.provider] });
	expect(decisions).toMatchObject([
		{ key: String(asked.id), kind: "run", blocked: "credential removed", recoveries: 1 },
	]);
	third.resume();
	for (const id of [asked.id, followUp.id]) {
		const settled = await (await third.submission(id, context))!.wait(context);
		expect(settled.status).toBe("unanswered");
	}
	await third.waitForIdle(context);
	expect(faux.state.callCount).toBe(1);
	expect((await third.inspect(context)).tasks).toEqual([]);
	await third.close(context);
});

it("aborts a background task of a chat whose provider's credential was removed", async () => {
	const { model, open } = setup();
	hangStarts = 0;
	hangStarted = Promise.withResolvers<void>();
	const first = await open();
	const root = await first.root(context, { agent: { model } });
	const taskId = await root.commit(
		(tx) => tx.createTask(Hang, null, { ownership: { kind: "conversation" }, background: true }),
		context,
	);
	first.resume();
	await hangStarted.promise;
	await first.close(context);

	const second = await open();
	const decisions = await checkRestarts(second, context, { ...sameSession, stopping: [model.provider] });
	expect(decisions).toEqual([
		{ key: `task:${taskId}`, kind: "background", taskId, recoveries: 0, blocked: "credential removed" },
	]);
	const settled = await second.waitForTask(taskId, context);
	expect(settled.state.outcome.status).toBe("aborted");
	expect(hangStarts).toBe(1);
	await second.close(context);
});

it("a background task has its own recovery budget", async () => {
	const { model, open } = setup();
	hangStarts = 0;
	hangStarted = Promise.withResolvers<void>();
	const first = await open();
	const root = await first.root(context, { agent: { model } });
	const taskId = await root.commit(
		(tx) => tx.createTask(Hang, null, { ownership: { kind: "conversation" }, background: true }),
		context,
	);
	first.resume();
	await hangStarted.promise;
	await first.close(context);

	for (let restart = 1; restart <= MAX_BACKGROUND_RECOVERIES; restart++) {
		const harness = await open();
		hangStarted = Promise.withResolvers<void>();
		const decisions = await checkRestarts(harness, context, sameSession);
		expect(decisions).toEqual([{ key: `task:${taskId}`, kind: "background", taskId, recoveries: restart }]);
		harness.resume();
		await hangStarted.promise;
		await harness.close(context);
	}

	const blocked = await open();
	const decisions = await checkRestarts(blocked, context, sameSession);
	expect(decisions).toMatchObject([{ kind: "background", blocked: "budget", recoveries: MAX_BACKGROUND_RECOVERIES }]);
	const settled = await blocked.waitForTask(taskId, context);
	expect(settled.state.outcome.status).toBe("aborted");
	expect(hangStarts).toBe(1 + MAX_BACKGROUND_RECOVERIES);
	await blocked.close(context);
});
