import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import {
  GoogleGenAI,
  Type,
  FunctionCallingConfigMode,
  FinishReason,
  ApiError,
} from "@google/genai";
import type { Content, FunctionDeclaration, Part, ToolConfig } from "@google/genai";
import { Octokit } from "@octokit/rest";
import {
  SYSTEM_PROMPT,
  MAX_SCREEN_IDENTIFIER_LENGTH,
  MAX_DIRECT_IMAGE_BYTES,
  parseFigmaURL,
  fetchFigmaImageDataURL,
  normalizeImageMediaType,
} from "./figmaCompare";
import type {
  FigmaCompareRequest,
  FigmaCompareResponseBody,
  FigmaFrameRef,
  ReportedDifference,
  SupportedImageMediaType,
} from "./figmaCompare";

// Gemini variant of figmaCompare: same request/response contract, same agent
// flow (list_files / read_file / report_differences), but uses Gemini instead
// of Claude as the model. PR creation / Jira ticket flows are intentionally
// ABSENT — this function only produces a comparison report; the client does
// not call figmaApplyFix / createBugTicket in Gemini mode.
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const githubToken = defineSecret("GITHUB_TOKEN");
const figmaToken = defineSecret("FIGMA_TOKEN");

const githubOwner = defineString("GITHUB_OWNER", { default: "emrebuyuker" });
const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-ios-client" });
const iosSourceRoot = defineString("IOS_SOURCE_ROOT", { default: "ClaudeBugPoC" });

// gemini-3.5-flash: stable channel, supports images. Preview models (which can
// be removed with ~2 weeks notice) are not pinned for production.
const GEMINI_MODEL = "gemini-3.5-flash";
// In Gemini, thinking tokens also count against the maxOutputTokens budget;
// instead of Claude's 8192 we leave headroom so a thought-heavy turn doesn't
// exhaust the budget before producing visible output / a function call.
const MAX_TOKENS_PER_RESPONSE = 16384;
const MAX_AGENT_ITERATIONS = 16;

// Image MIME types accepted by Gemini are png/jpeg/webp/heic/heif — no GIF.
// In practice the client only sends png/jpeg (encodeForUpload + Figma render);
// still, fail explicitly on an unrecognized type so it doesn't silently hit a
// Gemini 400.
const GEMINI_IMAGE_MIME_TYPES: readonly SupportedImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

// On the free tier the per-minute quota (RPM) is low; a 16-iteration agent loop
// easily hits 429. On 429 we wait for the quota window to refresh and retry a
// limited number of times — bounded to stay within the 540s function timeout.
// (Unlike the "no retry" decision for Figma /v1/images: the Gemini RPM quota
// refreshes every minute, so waiting doesn't spend quota.)
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_DEFAULT_DELAY_MS = 30_000;
const RATE_LIMIT_MAX_DELAY_MS = 65_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Extract the suggested wait time from the 429 message (RetryInfo '"retryDelay":"32s"'
// or "Please retry in 32.5s" formats); fall back to the default if not found.
const parseRetryDelayMs = (message: string): number => {
  const match = message.match(/retry(?:Delay"?\s*:\s*"?|\s+in\s+)([\d.]+)\s*s/i);
  const seconds = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return RATE_LIMIT_DEFAULT_DELAY_MS;
  return Math.min(Math.ceil(seconds * 1000) + 1000, RATE_LIMIT_MAX_DELAY_MS);
};

const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "list_files",
    description:
      "List files and directories at the given path in the GitHub repository. Use empty string for root.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "Directory path relative to repo root (e.g. 'ClaudeBugPoC/Scenes/Pokemon').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file from the GitHub repository.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "File path relative to repo root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "report_differences",
    description:
      "Submit the final list of design differences between the Figma frame and the iOS screen. Call this exactly once as your final action.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        detectedScreen: {
          type: Type.STRING,
          description: "The primary VC/View type name you inspected.",
        },
        summary: {
          type: Type.STRING,
          description: "Short Turkish summary (1-2 sentences) of the overall comparison.",
        },
        differences: {
          type: Type.ARRAY,
          description: "List of differences. Empty array if no significant differences were found.",
          items: {
            type: Type.OBJECT,
            properties: {
              category: {
                type: Type.STRING,
                enum: ["layout", "color", "typography", "spacing", "missing", "extra", "icons", "other"],
              },
              severity: {
                type: Type.STRING,
                enum: ["high", "medium", "low"],
              },
              title: { type: Type.STRING, description: "Short Turkish title." },
              detail: { type: Type.STRING, description: "1-3 sentence Turkish description." },
              codeHint: {
                type: Type.STRING,
                description: "Optional file:line or code fragment reference.",
              },
            },
            required: ["category", "severity", "title", "detail"],
          },
        },
      },
      required: ["detectedScreen", "summary", "differences"],
    },
  },
];

export const figmaCompareGemini = onCall<FigmaCompareRequest, Promise<FigmaCompareResponseBody>>(
  {
    secrets: [geminiApiKey, githubToken, figmaToken],
    maxInstances: 5,
    timeoutSeconds: 540,
    memory: "512MiB",
    region: "us-central1",
  },
  async (request: CallableRequest<FigmaCompareRequest>): Promise<FigmaCompareResponseBody> => {
    const { figmaURL, screenIdentifier, imageBase64, imageMediaType } = request.data;

    if (!screenIdentifier || typeof screenIdentifier !== "string") {
      throw new HttpsError("invalid-argument", "screenIdentifier is required (string).");
    }
    if (screenIdentifier.length > MAX_SCREEN_IDENTIFIER_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `screenIdentifier exceeds max length (${MAX_SCREEN_IDENTIFIER_LENGTH}).`
      );
    }

    const hasDirectImage = typeof imageBase64 === "string" && imageBase64.length > 0;
    let figmaRef: FigmaFrameRef | null = null;
    if (!hasDirectImage) {
      if (!figmaURL || typeof figmaURL !== "string") {
        throw new HttpsError(
          "invalid-argument",
          "figmaURL is required when no imageBase64 is provided."
        );
      }
      figmaRef = parseFigmaURL(figmaURL);
      if (!figmaRef) {
        throw new HttpsError(
          "invalid-argument",
          "figmaURL is not a recognized Figma frame URL with a node-id."
        );
      }
    }

    const owner = githubOwner.value();
    const repo = githubRepo.value();
    const sourceRoot = iosSourceRoot.value();

    logger.info("figmaCompareGemini request received", {
      mode: hasDirectImage ? "direct-image" : "figma-render",
      fileId: figmaRef?.fileId,
      nodeId: figmaRef?.nodeId,
      screenIdentifier,
    });

    try {
      let figmaImage: { base64: string; mediaType: SupportedImageMediaType };
      if (typeof imageBase64 === "string" && imageBase64.length > 0) {
        const bytes = Buffer.from(imageBase64, "base64").byteLength;
        if (bytes === 0) {
          throw new HttpsError("invalid-argument", "imageBase64 geçersiz base64.");
        }
        if (bytes > MAX_DIRECT_IMAGE_BYTES) {
          throw new HttpsError(
            "invalid-argument",
            `Görsel çok büyük (${bytes} bayt). En fazla ${MAX_DIRECT_IMAGE_BYTES} bayt; ` +
              "daha düşük çözünürlükte (ör. @2x yerine @1x) gönderin."
          );
        }
        figmaImage = {
          base64: imageBase64,
          mediaType: normalizeImageMediaType(imageMediaType),
        };
        if (!GEMINI_IMAGE_MIME_TYPES.includes(figmaImage.mediaType)) {
          throw new HttpsError(
            "invalid-argument",
            `Gemini '${figmaImage.mediaType}' görsel tipini desteklemiyor. ` +
              "PNG, JPEG ya da WebP gönderin."
          );
        }
        logger.info("figmaCompareGemini using client image (Figma bypassed)", {
          bytes,
          mediaType: figmaImage.mediaType,
        });
      } else if (figmaRef) {
        figmaImage = await fetchFigmaImageDataURL(figmaRef, figmaToken.value());
        logger.info("Figma image fetched", {
          fileId: figmaRef.fileId,
          nodeId: figmaRef.nodeId,
          bytesBase64: figmaImage.base64.length,
        });
      } else {
        throw new HttpsError(
          "invalid-argument",
          "Geçerli bir imageBase64 ya da figmaURL sağlanmadı."
        );
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
      const octokit = new Octokit({ auth: githubToken.value() });

      const generateWithRetry = async (
        params: Parameters<typeof ai.models.generateContent>[0]
      ) => {
        let attempt = 0;
        for (;;) {
          try {
            return await ai.models.generateContent(params);
          } catch (e) {
            if (!(e instanceof ApiError) || e.status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) {
              throw e;
            }
            attempt++;
            const delayMs = parseRetryDelayMs(e.message);
            logger.warn("figmaCompareGemini 429 — kota penceresi bekleniyor", {
              attempt,
              delayMs,
            });
            await sleep(delayMs);
          }
        }
      };

      const readGitHubFile = async (path: string): Promise<string> => {
        try {
          const response = await octokit.repos.getContent({ owner, repo, path });
          if (Array.isArray(response.data)) {
            return `Error: '${path}' is a directory. Use list_files.`;
          }
          if (response.data.type !== "file" || !("content" in response.data)) {
            return `Error: '${path}' is not a readable file.`;
          }
          const decoded = Buffer.from(response.data.content, "base64").toString("utf-8");
          if (decoded.length > 50000) {
            return decoded.slice(0, 50000) + "\n... [truncated]";
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
            return `Error: '${path}' is a file, not a directory.`;
          }
          return response.data
            .map((item) => `${item.type === "dir" ? "[dir]" : "[file]"} ${item.path}`)
            .join("\n");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return `Error listing '${path}': ${msg}`;
        }
      };

      let reported: {
        detectedScreen: string;
        summary: string;
        differences: ReportedDifference[];
      } | null = null;

      const recordReport = (input: {
        detectedScreen: string;
        summary: string;
        differences: ReportedDifference[];
      }): string => {
        if (reported) {
          return "Error: report_differences was already called. Do not call it again.";
        }
        if (!Array.isArray(input.differences)) {
          return "Error: differences must be an array.";
        }
        // Filter out non-object elements: a single malformed element makes the
        // whole response fail the "[[String: Any]]" cast on iOS, trashing the report.
        const validDifferences = input.differences.filter(
          (d): d is ReportedDifference => typeof d === "object" && d !== null
        );
        reported = {
          detectedScreen: input.detectedScreen,
          summary: input.summary,
          differences: validDifferences,
        };
        return "OK: report registered. End your turn now.";
      };

      const systemPrompt = SYSTEM_PROMPT.replace(/\{\{IOS_SOURCE_ROOT\}\}/g, sourceRoot);

      const contents: Content[] = [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: figmaImage.mediaType,
                data: figmaImage.base64,
              },
            },
            {
              text: [
                `GitHub repo: ${owner}/${repo}`,
                `iOS kaynak dizini: ${sourceRoot}`,
                `Karşılaştırılacak ekran (VC tip adı): ${screenIdentifier}`,
                figmaRef
                  ? `Figma frame: file=${figmaRef.fileId}, node=${figmaRef.nodeId}`
                  : "Figma görseli: kullanıcı tarafından doğrudan yüklendi (URL yok).",
                "",
                "Yukarıdaki Figma frame görselini, kullanıcının bulunduğu iOS ekranıyla karşılaştır. " +
                  "Önce Scenes/ altında ilgili klasörü list_files ile bul, sonra View/VC/Cell dosyalarını oku, " +
                  "ardından report_differences ile tüm farkları rapor et.",
              ].join("\n"),
            },
          ],
        },
      ];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheReadTokens = 0;
      let iterations = 0;

      while (iterations < MAX_AGENT_ITERATIONS) {
        iterations++;

        // FORCE report_differences on the last allowed turn (the equivalent of
        // Claude's tool_choice): mode ANY + allowedFunctionNames permits only this tool.
        const forceReport = iterations >= MAX_AGENT_ITERATIONS;
        const toolConfig: ToolConfig | undefined = forceReport
          ? {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: ["report_differences"],
            },
          }
          : undefined;

        const response = await generateWithRetry({
          model: GEMINI_MODEL,
          contents,
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: MAX_TOKENS_PER_RESPONSE,
            tools: [{ functionDeclarations }],
            toolConfig,
          },
        });

        // In Gemini, thinking tokens are billed at the output price, so we include
        // them in outputTokens. cachedContentTokenCount reports implicit cache
        // hits (a subset of promptTokenCount).
        const usage = response.usageMetadata;
        totalInputTokens += usage?.promptTokenCount ?? 0;
        totalOutputTokens += (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
        totalCacheReadTokens += usage?.cachedContentTokenCount ?? 0;

        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) {
          throw new HttpsError(
            "failed-precondition",
            `Gemini isteği engelledi (${blockReason}): ` +
              `${response.promptFeedback?.blockReasonMessage ?? "güvenlik filtresi"}.`
          );
        }

        const candidate = response.candidates?.[0];
        const parts: Part[] = candidate?.content?.parts ?? [];
        const functionCalls = parts
          .map((part) => part.functionCall)
          .filter((call): call is NonNullable<typeof call> => Boolean(call));

        logger.info("figmaCompareGemini iteration", {
          iteration: iterations,
          finishReason: candidate?.finishReason,
          functionCalls: functionCalls.map((call) => call.name),
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          thoughtsTokens: usage?.thoughtsTokenCount ?? 0,
          cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
        });

        if (functionCalls.length === 0) {
          if (reported) break;
          if (
            candidate?.finishReason === FinishReason.SAFETY ||
            candidate?.finishReason === FinishReason.PROHIBITED_CONTENT ||
            candidate?.finishReason === FinishReason.IMAGE_SAFETY
          ) {
            throw new HttpsError(
              "failed-precondition",
              `Gemini yanıtı güvenlik filtresine takıldı (${candidate.finishReason}).`
            );
          }
          // The model ended its turn without calling a function (STOP/MAX_TOKENS/
          // malformed): append its reply and explicitly ask for the report. The
          // final turn will force the report anyway. Even if the model turn is
          // EMPTY we push a placeholder — the Gemini API can reject two consecutive
          // user-role contents with 400 INVALID_ARGUMENT.
          if (candidate?.content && parts.length > 0) {
            contents.push(candidate.content);
          } else {
            contents.push({
              role: "model",
              parts: [{ text: "(kullanılabilir çıktı üretilemedi)" }],
            });
          }
          contents.push({
            role: "user",
            parts: [
              {
                text:
                  "Henüz report_differences çağırmadın. Topladığın bilgilerle ŞİMDİ " +
                  "report_differences tool'unu çağır — başka tool çağırma, düz metin yazma.",
              },
            ],
          });
          continue;
        }

        if (candidate?.content) {
          contents.push(candidate.content);
        }

        const responseParts: Part[] = [];
        for (const call of functionCalls) {
          const args = (call.args ?? {}) as Record<string, unknown>;

          let result: string;
          if (call.name === "read_file") {
            result = await readGitHubFile(String(args.path ?? ""));
          } else if (call.name === "list_files") {
            result = await listGitHubFiles(String(args.path ?? ""));
          } else if (call.name === "report_differences") {
            result = recordReport(args as {
              detectedScreen: string;
              summary: string;
              differences: ReportedDifference[];
            });
          } else {
            result = `Unknown tool: ${call.name}`;
          }

          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { result },
            },
          });
        }

        contents.push({ role: "user", parts: responseParts });

        if (reported) break;
      }

      if (!reported) {
        throw new HttpsError(
          "failed-precondition",
          `figmaCompareGemini ${iterations} turda rapor üretemedi. Ekran beklenenden ` +
            "karmaşık olabilir ya da model raporu tamamlayamadı; lütfen tekrar deneyin."
        );
      }

      // Pricing — gemini-3.5-flash per 1M tokens: input $1.50 · output $9.00
      // (thinking tokens included). The implicit cache discount is not modeled —
      // the estimate runs slightly high.
      const estimatedCostUsd =
        (totalInputTokens / 1_000_000) * 1.5 +
        (totalOutputTokens / 1_000_000) * 9;

      const result: {
        detectedScreen: string;
        summary: string;
        differences: ReportedDifference[];
      } = reported;
      return {
        detectedScreen: result.detectedScreen,
        summary: result.summary,
        differences: result.differences,
        iterations,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheCreationTokens: 0,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("figmaCompareGemini failed", { message });
      // The "internal" code is masked by the iOS Firebase Functions SDK —
      // we use "unavailable" so the message reaches the client.
      throw new HttpsError("unavailable", `figmaCompareGemini hatası: ${message}`);
    }
  }
);
