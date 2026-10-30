import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness, LiveDoc, type TaskId } from "@earendil-works/pi-durable";

/**
 * Worker restarts that may resume one run. Each resume sends the interrupted request again, and the provider bills it
 * again. This limits recoveries only: pi-durable's own retries of a failed request (`DEFAULT_RETRY_POLICY`) are separate.
 */
export const MAX_AUTOMATIC_RECOVERIES = 1;

/** The same limit for a background task, such as a compaction, which belongs to no run. */
export const MAX_BACKGROUND_RECOVERIES = 1;

/** Recoveries so far: a run by the submission ID of its first input, a background task by `task:<id>`. */
const BreakerDoc = defineDoc<{ runs: Record<string, number> }>({
	kind: "piaside.breaker",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {} }),
	// A full copy every 50 changes bounds what an open replays.
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

export type RestartDecision = {
	key: string;
	kind: "run" | "background";
	taskId: TaskId;
	recoveries: number;
	/** Set when the work is aborted instead of resumed. */
	blocked?: "budget" | "new browser session" | "credential removed";
};

type Work = {
	key: string;
	kind: RestartDecision["kind"];
	taskId: TaskId;
	conversationId: ConversationId;
	/** Its chat's model is on a provider whose credential a removal deleted before stopping this work. */
	removed: boolean;
};

/**
 * Call once per worker lifetime, after `Harness.open()` and before anything enables scheduling: work over its budget is
 * aborted while scheduling is still paused, so it never sends another request. Counting per worker start, not per
 * alarm, keeps alarms that fire on a running worker from using up the budget.
 *
 * In a new browser session (`chrome.storage.session` was empty), unfinished work is aborted, not resumed: the user may
 * have closed the browser on purpose, and an unattended, billed request hours later is a surprise. Retry is one click.
 * Work on a provider in `stopping` is aborted too, without counting a recovery: a removal deleted its credential, and a
 * worker stop came before the removal stopped it (design 6.20).
 *
 * pi-durable 1.4's `restartLimit` does not replace this: it counts only crashes with no new committed state, and parks
 * a task instead of aborting it; it knows nothing of browser sessions or removed credentials.
 */
export async function checkRestarts(
	harness: Harness,
	context: Context,
	options: { newBrowserSession: boolean; stopping?: readonly string[] },
): Promise<RestartDecision[]> {
	const inspection = await harness.inspect(context);
	// An abort-marked task sends no request: its abort handler runs at resume.
	const marked = new Set(
		inspection.tasks.filter((task) => task.record.abortRequested).map((task) => String(task.record.id)),
	);
	const work: Work[] = [];
	const removed = async (conversationId: ConversationId) => {
		if (!options.stopping?.length) return false;
		const conversation = await harness.conversation(conversationId, context);
		const provider = conversation === undefined ? undefined : (await conversation.agent(context)).model?.provider;
		return provider !== undefined && options.stopping.includes(provider);
	};
	const conversations = new Set(
		inspection.tasks.filter((task) => !task.record.background).map((task) => task.record.conversationId),
	);
	for (const conversationId of conversations) {
		const run = (await harness.snapshot(LiveDoc, conversationId, context))?.run;
		if (run === undefined || marked.has(String(run.taskId))) continue;
		work.push({
			key: String(run.inputs[0] ?? run.taskId),
			kind: "run",
			taskId: run.taskId,
			conversationId,
			removed: await removed(conversationId),
		});
	}
	for (const { record } of inspection.tasks) {
		// Tasks that a background task owns stop with it, so only the top one counts.
		if (!record.background || record.owner !== undefined || marked.has(String(record.id))) continue;
		work.push({
			key: `task:${record.id}`,
			kind: "background",
			taskId: record.id,
			conversationId: record.conversationId,
			removed: await removed(record.conversationId),
		});
	}

	const decisions = await harness.commit(async (tx) => {
		const doc = await tx.doc(BreakerDoc);
		for (const key of Object.keys(doc.runs)) {
			if (!work.some((item) => item.key === key)) delete doc.runs[key];
		}
		return work.map(({ key, kind, taskId, removed }): RestartDecision => {
			const recoveries = doc.runs[key] ?? 0;
			if (removed) return { key, kind, taskId, recoveries, blocked: "credential removed" };
			if (options.newBrowserSession) return { key, kind, taskId, recoveries, blocked: "new browser session" };
			const limit = kind === "run" ? MAX_AUTOMATIC_RECOVERIES : MAX_BACKGROUND_RECOVERIES;
			if (recoveries >= limit) return { key, kind, taskId, recoveries, blocked: "budget" };
			doc.runs[key] = recoveries + 1;
			return { key, kind, taskId, recoveries: recoveries + 1 };
		});
	}, context);

	// The decision is committed first: a worker stopped before the abort still blocks the work on its next start.
	for (const decision of decisions) {
		if (decision.blocked === undefined) continue;
		const { conversationId } = work.find((item) => item.key === decision.key)!;
		if (decision.kind === "run") {
			// `abortTask()` ends only the run. An input queued behind it would start the next run and be answered before
			// the user's Retry. Withdraw them first, as Esc does; while the run is not abort-marked, a restart redoes this.
			for (const submission of inspection.submissions) {
				if (submission.conversationId === conversationId && submission.status === "queued") {
					await harness.abortSubmission(submission.id, context, conversationId);
				}
			}
		}
		await harness.abortTask(decision.taskId, context);
	}
	return decisions;
}
