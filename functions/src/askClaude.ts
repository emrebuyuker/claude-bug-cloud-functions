import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const githubToken = defineSecret("GITHUB_TOKEN");

const githubOwner = defineString("GITHUB_OWNER", { default: "REPLACE_ME" });
const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-test" });

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_PER_RESPONSE = 4096;
const MAX_AGENT_ITERATIONS = 10;
const MAX_BUG_DESCRIPTION_LENGTH = 5000;

const SYSTEM_PROMPT = `Sen kıdemli bir iOS geliştirici (Swift, UIKit) AI asistanısın.
Görevin: Bug raporlarını okuyup, GitHub'daki kaynak kodu inceleyerek root cause'u bulup somut fix önermek.

Yaklaşım:
1. Önce ilgili dizini list_files ile keşfet
2. Şüpheli görünen dosyaları read_file ile oku
3. Root cause'u tespit et — varsayım yapma, koda bak
4. Concrete fix sun: hangi dosya, hangi satır, ne değişmeli, neden

Cevap formatı:
- ## Root Cause: (problem ne)
- ## Affected Files: (hangi dosyalar)
- ## Fix: (kod örneği ile)
- ## Why: (neden bu fix işe yarar)

Önemli:
- Tahmin etme, sadece okuduğun koda dayanarak konuş
- Eğer yetersiz bilgi varsa dosya oku, sorma
- Cevabın Türkçe olsun
- Kod örneklerini swift code block içinde ver`;

const tools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List files and directories at the given path in the GitHub repository. Use empty string for root directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to repo root (e.g. '' for root, 'FakeAppCode' for subfolder)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file from the GitHub repository.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to repo root (e.g. 'FakeAppCode/FeedViewController.swift')",
        },
      },
      required: ["path"],
    },
  },
];

interface BugReportRequest {
  bugDescription: string;
}

interface BugReportResponse {
  answer: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export const askClaude = onCall<BugReportRequest, Promise<BugReportResponse>>(
  {
    secrets: [anthropicApiKey, githubToken],
    maxInstances: 5,
    timeoutSeconds: 120,
    memory: "512MiB",
    region: "us-central1",
    // TODO: enforce App Check once the iOS app is registered in Firebase
    // Console with App Attest (requires a paid Apple Developer account).
    // Add `enforceAppCheck: true` here, then redeploy.
  },
  async (request: CallableRequest<BugReportRequest>): Promise<BugReportResponse> => {
    const { bugDescription } = request.data;

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

    const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });
    const octokit = new Octokit({ auth: githubToken.value() });

    const readGitHubFile = async (path: string): Promise<string> => {
      try {
        const response = await octokit.repos.getContent({ owner, repo, path });
        if (Array.isArray(response.data)) {
          return `Error: '${path}' is a directory, not a file. Use list_files instead.`;
        }
        if (response.data.type !== "file" || !("content" in response.data)) {
          return `Error: '${path}' is not a readable file.`;
        }
        const decoded = Buffer.from(response.data.content, "base64").toString("utf-8");
        if (decoded.length > 50000) {
          return decoded.slice(0, 50000) + "\n... [truncated, file too large]";
        }
        return decoded;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error reading '${path}': ${msg}`;
      }
    };

    const listGitHubFiles = async (path: string): Promise<string> => {
      try {
        const response = await octokit.repos.getContent({ owner, repo, path });
        if (!Array.isArray(response.data)) {
          return `Error: '${path}' is a file, not a directory. Use read_file instead.`;
        }
        return response.data
          .map((item) => `${item.type === "dir" ? "[dir]" : "[file]"} ${item.path}`)
          .join("\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error listing '${path}': ${msg}`;
      }
    };

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `GitHub repo: ${owner}/${repo}\n\nBug raporu:\n${bugDescription}`,
      },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;

    while (iterations < MAX_AGENT_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_PER_RESPONSE,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      logger.info("Claude iteration", {
        iteration: iterations,
        stopReason: response.stop_reason,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });

      if (response.stop_reason === "end_turn") {
        const textBlock = response.content.find((b) => b.type === "text");
        const answer =
          textBlock && textBlock.type === "text"
            ? textBlock.text
            : "(Claude bir cevap üretemedi)";

        const estimatedCostUsd =
          (totalInputTokens / 1_000_000) * 3 + (totalOutputTokens / 1_000_000) * 15;

        return {
          answer,
          iterations,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
        };
      }

      if (response.stop_reason !== "tool_use") {
        throw new HttpsError(
          "internal",
          `Unexpected stop_reason: ${response.stop_reason}`
        );
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const input = block.input as { path: string };
        let result: string;

        if (block.name === "read_file") {
          result = await readGitHubFile(input.path);
        } else if (block.name === "list_files") {
          result = await listGitHubFiles(input.path);
        } else {
          result = `Unknown tool: ${block.name}`;
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    throw new HttpsError(
      "internal",
      `Agent loop exceeded max iterations (${MAX_AGENT_ITERATIONS}).`
    );
  }
);
