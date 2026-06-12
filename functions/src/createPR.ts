import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { Octokit } from "@octokit/rest";

const githubToken = defineSecret("GITHUB_TOKEN");
const githubOwner = defineString("GITHUB_OWNER", { default: "emrebuyuker" });
const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-ios-client" });
const baseBranch = defineString("PR_BASE_BRANCH", { default: "main" });

const MAX_ACCEPTED_CHANGES = 20;
const MAX_FILE_BYTES = 200_000;

interface AcceptedChange {
  filePath: string;
  newContent: string;
  description?: string;
}

interface CreatePRRequest {
  bugTitle: string;
  bugDescription?: string;
  changes: AcceptedChange[];
}

interface CreatePRResponse {
  prUrl: string;
  prNumber: number;
  branch: string;
  commitSha: string;
}

const sanitizeBranchSegment = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "fix";
};

export const createPR = onCall<CreatePRRequest, Promise<CreatePRResponse>>(
  {
    secrets: [githubToken],
    maxInstances: 5,
    timeoutSeconds: 60,
    memory: "256MiB",
    region: "us-central1",
  },
  async (request: CallableRequest<CreatePRRequest>): Promise<CreatePRResponse> => {
    const { bugTitle, bugDescription, changes } = request.data;

    if (!bugTitle || typeof bugTitle !== "string") {
      throw new HttpsError("invalid-argument", "bugTitle is required (string).");
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new HttpsError("invalid-argument", "changes must be a non-empty array.");
    }
    if (changes.length > MAX_ACCEPTED_CHANGES) {
      throw new HttpsError(
        "invalid-argument",
        `Too many changes (${changes.length}); max is ${MAX_ACCEPTED_CHANGES}.`
      );
    }
    for (const c of changes) {
      if (!c.filePath || typeof c.filePath !== "string") {
        throw new HttpsError("invalid-argument", "Each change needs a filePath string.");
      }
      if (typeof c.newContent !== "string") {
        throw new HttpsError("invalid-argument", "Each change needs a newContent string.");
      }
      if (Buffer.byteLength(c.newContent, "utf-8") > MAX_FILE_BYTES) {
        throw new HttpsError(
          "invalid-argument",
          `'${c.filePath}' exceeds max size (${MAX_FILE_BYTES} bytes).`
        );
      }
    }

    const owner = githubOwner.value();
    const repo = githubRepo.value();
    const base = baseBranch.value();
    if (owner === "REPLACE_ME") {
      throw new HttpsError(
        "failed-precondition",
        "GITHUB_OWNER param is not configured."
      );
    }

    const octokit = new Octokit({ auth: githubToken.value() });

    try {
      const baseRef = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${base}`,
      });
      const baseCommitSha = baseRef.data.object.sha;

      const baseCommit = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: baseCommitSha,
      });
      const baseTreeSha = baseCommit.data.tree.sha;

      const blobs = await Promise.all(
        changes.map(async (c) => {
          const blob = await octokit.git.createBlob({
            owner,
            repo,
            content: Buffer.from(c.newContent, "utf-8").toString("base64"),
            encoding: "base64",
          });
          return {
            path: c.filePath,
            mode: "100644" as const,
            type: "blob" as const,
            sha: blob.data.sha,
          };
        })
      );

      const newTree = await octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: blobs,
      });

      const fileList = changes.map((c) => `- ${c.filePath}`).join("\n");
      const commitMessage = `fix: ${bugTitle}\n\nProposed by Claude in response to:\n${
        (bugDescription || bugTitle).slice(0, 500)
      }\n\nChanged files:\n${fileList}`;

      const newCommit = await octokit.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: newTree.data.sha,
        parents: [baseCommitSha],
      });

      const timestamp = Date.now();
      const branchName = `claude/fix-${sanitizeBranchSegment(bugTitle)}-${timestamp}`;

      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: newCommit.data.sha,
      });

      const bullets = changes
        .map((c, i) => {
          const desc = c.description ? ` — ${c.description}` : "";
          return `${i + 1}. \`${c.filePath}\`${desc}`;
        })
        .join("\n");

      const prBody = [
        "## Bug",
        bugDescription || bugTitle,
        "",
        "## Claude'un Önerdiği Değişiklikler",
        bullets,
        "",
        "---",
        "*Bu PR Claude tarafından otomatik açıldı (claude-bug-ios-client).*",
      ].join("\n");

      const pr = await octokit.pulls.create({
        owner,
        repo,
        title: `fix: ${bugTitle}`.slice(0, 100),
        head: branchName,
        base,
        body: prBody,
      });

      logger.info("PR created", {
        prNumber: pr.data.number,
        branch: branchName,
        fileCount: changes.length,
      });

      return {
        prUrl: pr.data.html_url,
        prNumber: pr.data.number,
        branch: branchName,
        commitSha: newCommit.data.sha,
      };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("createPR failed", { error: msg });
      // "internal" gets masked in the iOS SDK (bare "INTERNAL"); we use
      // "unavailable" so the GitHub error message is visible on the client.
      throw new HttpsError("unavailable", `PR oluşturulamadı: ${msg}`);
    }
  }
);
