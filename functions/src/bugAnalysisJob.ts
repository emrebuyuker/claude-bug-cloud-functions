import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { db } from "./firestore";
import { anthropicApiKey, githubToken, githubOwner, githubRepo, iosSourceRoot } from "./params";
import {
  runBugAnalysis,
  sanitizeActivityLog,
  MAX_BUG_DESCRIPTION_LENGTH,
  ProposedChange,
} from "./bugAnalysisCore";

const JOBS_COLLECTION = "bugJobs";
const PROPOSALS_SUBCOLLECTION = "proposals";

interface StartBugAnalysisRequest {
  bugDescription: string;
  /** Optional iOS-side activity timeline. */
  activityLog?: string;
}

interface StartBugAnalysisResponse {
  jobId: string;
}

/**
 * Creates a `bugJobs/{jobId}` document with status "pending" and returns the
 * jobId immediately. The heavy agentic analysis runs in `processBugAnalysis`
 * (triggered by this write), so the client never blocks on a long call and
 * cannot hit DEADLINE_EXCEEDED. The client listens to the job document for the
 * result.
 */
export const startBugAnalysis = onCall<StartBugAnalysisRequest, Promise<StartBugAnalysisResponse>>(
  {
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: "256MiB",
    region: "us-central1",
    // TODO: enforce App Check once the iOS app is registered (see askClaude).
  },
  async (request): Promise<StartBugAnalysisResponse> => {
    const { bugDescription, activityLog } = request.data;

    if (!bugDescription || typeof bugDescription !== "string") {
      throw new HttpsError("invalid-argument", "bugDescription is required (string).");
    }
    if (bugDescription.length > MAX_BUG_DESCRIPTION_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `bugDescription exceeds max length (${MAX_BUG_DESCRIPTION_LENGTH}).`
      );
    }

    const docRef = db.collection(JOBS_COLLECTION).doc();
    await docRef.set({
      status: "pending",
      bugDescription,
      activityLog: sanitizeActivityLog(activityLog) ?? null,
      iterations: 0,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("startBugAnalysis created job", { jobId: docRef.id });
    return { jobId: docRef.id };
  }
);

/**
 * Firestore-triggered worker. Runs the agentic loop for a freshly created job
 * and streams progress + the final result back into the job document. Has its
 * own long timeout (independent of any client deadline).
 */
export const processBugAnalysis = onDocumentCreated(
  {
    document: "bugJobs/{jobId}",
    secrets: [anthropicApiKey, githubToken],
    timeoutSeconds: 540,
    memory: "512MiB",
    region: "us-central1",
    // Don't auto-retry: the analysis is expensive and we already record failures
    // as `status: "error"` on the doc. (A hard crash/timeout leaves the job in
    // "running"; the client treats a long-running job as a soft timeout.)
    retry: false,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const jobId = event.params.jobId;
    const ref = snapshot.ref;

    // Firestore event delivery is at-least-once. Claim the job transactionally
    // so a duplicate event never runs the (expensive) analysis twice.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const data = fresh.data();
      if (!data || data.status !== "pending") return null;
      tx.update(ref, { status: "running", startedAt: FieldValue.serverTimestamp() });
      return data;
    });
    if (!claimed) {
      logger.info("processBugAnalysis skipped (already claimed)", { jobId });
      return;
    }

    const bugDescription = claimed.bugDescription as string;
    const activityLog = (claimed.activityLog as string | null) ?? undefined;

    try {
      const owner = githubOwner.value();
      const repo = githubRepo.value();
      if (owner === "REPLACE_ME") {
        throw new Error("GITHUB_OWNER param is not configured. Set it before deploy.");
      }

      const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });
      const octokit = new Octokit({ auth: githubToken.value() });

      const result = await runBugAnalysis({
        bugDescription,
        activityLog,
        anthropic,
        octokit,
        owner,
        repo,
        sourceRoot: iosSourceRoot.value(),
        onProgress: async (iterations) => {
          await ref.update({ iterations });
        },
      });

      // Proposals can each embed a full file (up to ~200KB, old + new), so a
      // multi-file fix would risk Firestore's 1 MiB document limit if stored on
      // the job doc. Write each proposal as its own doc in a subcollection.
      const batch = db.batch();
      result.proposedChanges.forEach((change: ProposedChange, index) => {
        const proposalRef = ref.collection(PROPOSALS_SUBCOLLECTION).doc(change.id);
        batch.set(proposalRef, { ...change, order: index });
      });
      await batch.commit();

      await ref.update({
        status: "done",
        answer: result.answer,
        iterations: result.iterations,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        proposalCount: result.proposedChanges.length,
        finishedAt: FieldValue.serverTimestamp(),
      });

      logger.info("processBugAnalysis done", {
        jobId,
        iterations: result.iterations,
        proposalCount: result.proposedChanges.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("processBugAnalysis failed", { jobId, message });
      await ref.update({
        status: "error",
        error: message,
        finishedAt: FieldValue.serverTimestamp(),
      });
    }
  }
);
