import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { anthropicApiKey, githubToken, githubOwner, githubRepo, iosSourceRoot } from "./params";
import {
  runBugAnalysis,
  sanitizeActivityLog,
  MAX_BUG_DESCRIPTION_LENGTH,
  BugReportResponse,
} from "./bugAnalysisCore";

interface BugReportRequest {
  bugDescription: string;
  /** Optional iOS-side activity timeline (compact "[T-Xs] TYPE target | k=v" lines). */
  activityLog?: string;
}

/**
 * Synchronous bug analysis. Kept for backward compatibility — the iOS client now
 * uses the async `startBugAnalysis` / `processBugAnalysis` job pair to avoid the
 * client-side DEADLINE_EXCEEDED that long agentic runs caused here. This callable
 * still works for short analyses and any non-iOS caller.
 */
export const askClaude = onCall<BugReportRequest, Promise<BugReportResponse>>(
  {
    secrets: [anthropicApiKey, githubToken],
    maxInstances: 5,
    timeoutSeconds: 300,
    memory: "512MiB",
    region: "us-central1",
    // TODO: enforce App Check once the iOS app is registered in Firebase
    // Console with App Attest (requires a paid Apple Developer account).
    // Add `enforceAppCheck: true` here, then redeploy.
  },
  async (request): Promise<BugReportResponse> => {
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

    const owner = githubOwner.value();
    const repo = githubRepo.value();
    if (owner === "REPLACE_ME") {
      throw new HttpsError(
        "failed-precondition",
        "GITHUB_OWNER param is not configured. Set it before deploy."
      );
    }

    try {
      const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });
      const octokit = new Octokit({ auth: githubToken.value() });
      return await runBugAnalysis({
        bugDescription,
        activityLog: sanitizeActivityLog(activityLog),
        anthropic,
        octokit,
        owner,
        repo,
        sourceRoot: iosSourceRoot.value(),
      });
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("askClaude failed", { message });
      // "internal" iOS SDK'sında maskelenir (çıplak "INTERNAL"); gerçek mesaj
      // görünsün diye "unavailable" (geçici / yeniden denenebilir) kullanıyoruz.
      throw new HttpsError("unavailable", `askClaude hatası: ${message}`);
    }
  }
);
