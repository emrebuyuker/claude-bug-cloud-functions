import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const githubToken = defineSecret("GITHUB_TOKEN");
const figmaToken = defineSecret("FIGMA_TOKEN");

const githubOwner = defineString("GITHUB_OWNER", { default: "emrebuyuker" });
const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-ios-client" });
const iosSourceRoot = defineString("IOS_SOURCE_ROOT", { default: "ClaudeBugPoC" });

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_PER_RESPONSE = 8192;
const MAX_AGENT_ITERATIONS = 10;
const MAX_SCREEN_IDENTIFIER_LENGTH = 120;
const FIGMA_IMAGE_SCALE = 2;
const MAX_FIGMA_IMAGE_BYTES = 8 * 1024 * 1024;

const SYSTEM_PROMPT = `Sen kıdemli bir iOS / UI tasarım QA asistanısın. Görevin: kullanıcının verdiği Figma frame görseli ile iOS uygulamasındaki canlı ekranı (Swift kodundan inceleyerek) karşılaştırıp yapısal ve stil farklarını listeleme.

iOS uygulama kaynakları "{{IOS_SOURCE_ROOT}}" dizini altında, UIKit + SnapKit kullanılıyor.

Yaklaşım:
1. Kullanıcı sana hangi ekranı incelediğini söyleyecek (VC tip adı, ör. "PokemonListViewController"). Bu VC için scene klasörünü "{{IOS_SOURCE_ROOT}}/Scenes/..." altında bul.
2. list_files ile keşfet, sonra read_file ile ilgili View / ViewController / Cell dosyalarını oku. SnapKit constraint'leri, font'lar, renkler, hierarchy bunlarda tanımlı.
3. Figma görselini incele: layout, renk, typography, spacing, hangi UI elementleri var, hangileri yok.
4. Kod ile görseli karşılaştır. Tahmin etme — sadece okuduğun kodda gördüğüne dayan.
5. Tüm farkları topladıktan SONRA tek bir report_differences tool çağrısı yap. Bu son tool çağrısı olmalı.

report_differences kuralları:
- detectedScreen: incelediğin ana VC/View tip adı.
- summary: 1-2 cümlelik Türkçe özet (en kritik fark + genel değerlendirme).
- differences: her bir görsel/yapısal fark için bir entry. Aynı kategoriden bile olsa AYRI element farkları AYRI entry olur.
  - category: layout | color | typography | spacing | missing | extra | icons | other
    * layout: hizalama, sıralama, blok pozisyonu
    * color: renk farkı (background, text, tint)
    * typography: font, size, weight
    * spacing: padding, margin, gap
    * missing: Figma'da var, kodda yok
    * extra: kodda var, Figma'da yok
    * icons: ikon farklı / yanlış
    * other: yukarıdakilere uymayan
  - severity: high (kritik, kullanıcı fark eder) | medium (gözden kaçmaz) | low (kozmetik)
  - title: kısa Türkçe başlık (ör. "Buton rengi tutmuyor")
  - detail: 1-3 cümlelik açıklama. Figma'da X, kodda Y şeklinde.
  - codeHint: (opsiyonel) ilgili dosya:satır veya kod parçası (ör. "PokemonListView.swift:42 — backgroundColor = .systemBackground")

Önemli:
- Türkçe yaz.
- Görselde olmayan veya kodda olmayan bir şeyi varsaymak yerine, sadece doğrudan gözlemlediğini raporla.
- Hiç fark bulamazsan boş differences array'iyle report_differences çağır (summary'de bunu açıkla).
- report_differences tool'unu sadece BİR KEZ çağır — son çağrı olarak.
- report_differences çağrısından sonra herhangi bir text response üretme; tool çağrısı yeterli.`;

const tools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List files and directories at the given path in the GitHub repository. Use empty string for root.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to repo root (e.g. 'ClaudeBugPoC/Scenes/Pokemon').",
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
          description: "File path relative to repo root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "report_differences",
    description: "Submit the final list of design differences between the Figma frame and the iOS screen. Call this exactly once as your final action.",
    input_schema: {
      type: "object",
      properties: {
        detectedScreen: {
          type: "string",
          description: "The primary VC/View type name you inspected.",
        },
        summary: {
          type: "string",
          description: "Short Turkish summary (1-2 sentences) of the overall comparison.",
        },
        differences: {
          type: "array",
          description: "List of differences. Empty array if no significant differences were found.",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: ["layout", "color", "typography", "spacing", "missing", "extra", "icons", "other"],
              },
              severity: {
                type: "string",
                enum: ["high", "medium", "low"],
              },
              title: { type: "string", description: "Short Turkish title." },
              detail: { type: "string", description: "1-3 sentence Turkish description." },
              codeHint: {
                type: "string",
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

interface FigmaCompareRequest {
  figmaURL: string;
  screenIdentifier: string;
}

interface ReportedDifference {
  category: string;
  severity: string;
  title: string;
  detail: string;
  codeHint?: string;
}

interface FigmaCompareResponseBody {
  detectedScreen: string;
  summary: string;
  differences: ReportedDifference[];
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

interface FigmaFrameRef {
  fileId: string;
  nodeId: string;
}

const FIGMA_URL_REGEX = /figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/;

export function parseFigmaURL(url: string): FigmaFrameRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.host.toLowerCase();
  if (!host.endsWith("figma.com")) return null;

  const match = parsed.pathname.match(FIGMA_URL_REGEX) ?? url.match(FIGMA_URL_REGEX);
  if (!match || !match[1]) return null;
  const fileId = match[1];

  const rawNodeId = parsed.searchParams.get("node-id");
  if (!rawNodeId) return null;
  // Figma deep links use "1-2" or "1:2"; Figma API requires colon form.
  const nodeId = rawNodeId.includes(":") ? rawNodeId : rawNodeId.replace(/-/g, ":");
  if (!/^\d+:\d+$/.test(nodeId)) return null;

  return { fileId, nodeId };
}

async function fetchFigmaImageDataURL(
  ref: FigmaFrameRef,
  token: string
): Promise<{ base64: string; mediaType: "image/png" }> {
  const imagesURL = new URL(`https://api.figma.com/v1/images/${ref.fileId}`);
  imagesURL.searchParams.set("ids", ref.nodeId);
  imagesURL.searchParams.set("format", "png");
  imagesURL.searchParams.set("scale", String(FIGMA_IMAGE_SCALE));

  const response = await fetch(imagesURL.toString(), {
    headers: { "X-Figma-Token": token },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpsError(
      "internal",
      `Figma API responded ${response.status}: ${body.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as {
    err?: string;
    images: Record<string, string | null>;
  };
  if (json.err) {
    throw new HttpsError("internal", `Figma API error: ${json.err}`);
  }
  const imageURL = json.images[ref.nodeId];
  if (!imageURL) {
    throw new HttpsError(
      "not-found",
      `Figma returned no image for node ${ref.nodeId}. Frame may be private or empty.`
    );
  }

  const imgResponse = await fetch(imageURL);
  if (!imgResponse.ok) {
    throw new HttpsError(
      "internal",
      `Figma CDN responded ${imgResponse.status} when downloading the PNG.`
    );
  }
  const arrayBuffer = await imgResponse.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FIGMA_IMAGE_BYTES) {
    throw new HttpsError(
      "resource-exhausted",
      `Figma image too large (${arrayBuffer.byteLength} bytes).`
    );
  }
  return {
    base64: Buffer.from(arrayBuffer).toString("base64"),
    mediaType: "image/png",
  };
}

export const figmaCompare = onCall<FigmaCompareRequest, Promise<FigmaCompareResponseBody>>(
  {
    secrets: [anthropicApiKey, githubToken, figmaToken],
    maxInstances: 5,
    timeoutSeconds: 240,
    memory: "512MiB",
    region: "us-central1",
  },
  async (request: CallableRequest<FigmaCompareRequest>): Promise<FigmaCompareResponseBody> => {
    const { figmaURL, screenIdentifier } = request.data;

    if (!figmaURL || typeof figmaURL !== "string") {
      throw new HttpsError("invalid-argument", "figmaURL is required (string).");
    }
    if (!screenIdentifier || typeof screenIdentifier !== "string") {
      throw new HttpsError("invalid-argument", "screenIdentifier is required (string).");
    }
    if (screenIdentifier.length > MAX_SCREEN_IDENTIFIER_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `screenIdentifier exceeds max length (${MAX_SCREEN_IDENTIFIER_LENGTH}).`
      );
    }

    const figmaRef = parseFigmaURL(figmaURL);
    if (!figmaRef) {
      throw new HttpsError(
        "invalid-argument",
        "figmaURL is not a recognized Figma frame URL with a node-id."
      );
    }

    const owner = githubOwner.value();
    const repo = githubRepo.value();
    const sourceRoot = iosSourceRoot.value();

    const figmaImage = await fetchFigmaImageDataURL(figmaRef, figmaToken.value());
    logger.info("Figma image fetched", {
      fileId: figmaRef.fileId,
      nodeId: figmaRef.nodeId,
      bytesBase64: figmaImage.base64.length,
    });

    const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });
    const octokit = new Octokit({ auth: githubToken.value() });

    const fileCache = new Map<string, string>();

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
        fileCache.set(path, decoded);
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
      reported = {
        detectedScreen: input.detectedScreen,
        summary: input.summary,
        differences: input.differences,
      };
      return "OK: report registered. End your turn now.";
    };

    const systemPrompt = SYSTEM_PROMPT.replace(/\{\{IOS_SOURCE_ROOT\}\}/g, sourceRoot);

    const userContent: Anthropic.ContentBlockParam[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: figmaImage.mediaType,
          data: figmaImage.base64,
        },
      },
      {
        type: "text",
        text: [
          `GitHub repo: ${owner}/${repo}`,
          `iOS kaynak dizini: ${sourceRoot}`,
          `Karşılaştırılacak ekran (VC tip adı): ${screenIdentifier}`,
          `Figma frame: file=${figmaRef.fileId}, node=${figmaRef.nodeId}`,
          "",
          "Yukarıdaki Figma frame görselini, kullanıcının bulunduğu iOS ekranıyla karşılaştır. " +
            "Önce Scenes/ altında ilgili klasörü list_files ile bul, sonra View/VC/Cell dosyalarını oku, " +
            "ardından report_differences ile tüm farkları rapor et.",
        ].join("\n"),
      },
    ];

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userContent },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let iterations = 0;

    while (iterations < MAX_AGENT_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_PER_RESPONSE,
        system: [{ type: "text", text: systemPrompt }],
        tools,
        messages,
      });

      const usage = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      totalInputTokens += usage.input_tokens;
      totalOutputTokens += usage.output_tokens;
      totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
      totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;

      logger.info("figmaCompare iteration", {
        iteration: iterations,
        stopReason: response.stop_reason,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      });

      if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
        if (!reported) {
          throw new HttpsError(
            "internal",
            "Claude finished without calling report_differences."
          );
        }
        break;
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

        let result: string;
        if (block.name === "read_file") {
          const input = block.input as { path: string };
          result = await readGitHubFile(input.path);
        } else if (block.name === "list_files") {
          const input = block.input as { path: string };
          result = await listGitHubFiles(input.path);
        } else if (block.name === "report_differences") {
          const input = block.input as {
            detectedScreen: string;
            summary: string;
            differences: ReportedDifference[];
          };
          result = recordReport(input);
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

      // Tool çağrısı yapıldıysa ve son çağrı report_differences ise, agent loop'u bitebilir.
      if (reported) {
        // Claude'a bir tur daha verip end_turn'u beklemek yerine direkt return ediyoruz —
        // report_differences çağrısı yapıldığı an iş bitmiş demektir.
        break;
      }
    }

    if (!reported) {
      throw new HttpsError(
        "internal",
        `figmaCompare agent loop ended without a report (iterations=${iterations}).`
      );
    }

    // Pricing — Sonnet 4.x per 1M tokens:
    //   input $3.00 · output $15.00 · cache write $3.75 · cache read $0.30
    const estimatedCostUsd =
      (totalInputTokens / 1_000_000) * 3 +
      (totalCacheCreationTokens / 1_000_000) * 3.75 +
      (totalCacheReadTokens / 1_000_000) * 0.3 +
      (totalOutputTokens / 1_000_000) * 15;

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
      cacheCreationTokens: totalCacheCreationTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    };
  }
);
