import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { getApps, initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

// Initialize the Admin SDK once (needed for the Storage cache). firestore.ts
// uses the same idempotent guard; whichever loads first does the init.
if (getApps().length === 0) {
  initializeApp();
}

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const githubToken = defineSecret("GITHUB_TOKEN");
const figmaToken = defineSecret("FIGMA_TOKEN");

const githubOwner = defineString("GITHUB_OWNER", { default: "emrebuyuker" });
const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-ios-client" });
const iosSourceRoot = defineString("IOS_SOURCE_ROOT", { default: "ClaudeBugPoC" });

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_PER_RESPONSE = 8192;
const MAX_AGENT_ITERATIONS = 16;
export const MAX_SCREEN_IDENTIFIER_LENGTH = 120;
const FIGMA_IMAGE_SCALE = 2;
const MAX_FIGMA_IMAGE_BYTES = 8 * 1024 * 1024;
// Limit for images uploaded directly by the client. Anthropic accepts ~5MB per
// image; we reject anything above that (also keeps the callable payload safe).
export const MAX_DIRECT_IMAGE_BYTES = 5 * 1024 * 1024;
const FIGMA_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
// Persistent (Storage) cache TTL — longer than L1: the goal is to reuse the
// render for days and protect the scarce /v1/images quota (6/month on
// View/Collab). Staleness caveat: if the Figma frame changes within this window
// a stale render is returned; after a design update either wait for the TTL to
// expire or shorten this constant.
const FIGMA_PERSISTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// figmaCompareGemini uses the same task definition — the prompt is provider-agnostic.
export const SYSTEM_PROMPT = `Sen kıdemli bir iOS / UI tasarım QA asistanısın. Görevin: kullanıcının verdiği Figma frame görseli ile iOS uygulamasındaki canlı ekranı (Swift kodundan inceleyerek) karşılaştırıp yapısal ve stil farklarını listeleme.

iOS uygulama kaynakları "{{IOS_SOURCE_ROOT}}" dizini altında, UIKit + SnapKit kullanılıyor.

Yaklaşım:
1. Kullanıcı sana hangi ekranı incelediğini söyleyecek (VC tip adı, ör. "PokemonListViewController"). Bu VC için scene klasörünü "{{IOS_SOURCE_ROOT}}/Scenes/..." altında bul.
2. list_files ile keşfet, sonra read_file ile ilgili View / ViewController / Cell dosyalarını oku. SnapKit constraint'leri, font'lar, renkler, hierarchy bunlarda tanımlı. VERİMLİ OL: bir scene klasöründeki birden çok dosyayı TEK turda paralel read_file çağrılarıyla oku — her dosya için ayrı tur harcama. Gereksiz keşfe dalma; ilgili klasörü bulur bulmaz dosyaları topluca oku ve hızlıca rapora geç. Tur sayın sınırlı; dağılırsan rapor üretmeden bütçeni tüketirsin.
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

export interface FigmaCompareRequest {
  // At least one of figmaURL or imageBase64 is required. If imageBase64 is given,
  // Figma /v1/images is NEVER hit (no quota issue) — the client sends the PNG directly.
  figmaURL?: string;
  screenIdentifier: string;
  imageBase64?: string;
  imageMediaType?: string;
}

export interface ReportedDifference {
  category: string;
  severity: string;
  title: string;
  detail: string;
  codeHint?: string;
}

export interface FigmaCompareResponseBody {
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

export interface FigmaFrameRef {
  fileId: string;
  nodeId: string;
}

// Image media types supported by Anthropic. We validate the client-provided
// value against this set and fall back to PNG for anything unrecognized.
export type SupportedImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const SUPPORTED_IMAGE_MEDIA_TYPES: readonly SupportedImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
export const normalizeImageMediaType = (raw: unknown): SupportedImageMediaType =>
  typeof raw === "string" && (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(raw)
    ? (raw as SupportedImageMediaType)
    : "image/png";

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

// Maps the Figma HTTP status to an HttpsError code that the iOS SDK does not
// mask (message preserved). Do NOT use "internal" — iOS shows a bare "INTERNAL".
type VisibleErrorCode =
  | "resource-exhausted"
  | "permission-denied"
  | "not-found"
  | "unavailable";

const mapFigmaStatusToCode = (status: number): VisibleErrorCode => {
  if (status === 429) return "resource-exhausted";
  if (status === 403) return "permission-denied";
  if (status === 404) return "not-found";
  return "unavailable";
};

// Caches the rendered Figma image in memory, keyed by fileId:nodeId:scale.
// /v1/images is a Tier-1 (most restricted) endpoint — re-rendering the same
// frame repeatedly burns the scarce quota. With a short TTL, repeated tests of
// the same frame cost a single render. (Cache is per instance; maxInstances=5
// → partial hit rate.)
const figmaImageCache = new Map<
  string,
  { base64: string; mediaType: "image/png"; expiresAt: number }
>();

// L2 (persistent) cache — writes the rendered PNG to Firebase Storage. The L1
// in-memory cache only catches short-lived repeats on the same instance
// (maxInstances=5 → partial hit rate); since L2 is shared across instances and
// cold starts, days of repeated tests of the same frame cost a single render.
// All Storage operations are wrapped in try/catch: if Storage isn't provisioned
// or a permission/network error occurs, it behaves as if the cache is disabled
// and the main flow is NEVER broken.
const persistentCachePath = (ref: FigmaFrameRef, scale: number): string =>
  `figma-render-cache/${ref.fileId}/${ref.nodeId.replace(/:/g, "-")}@${scale}x.png`;

async function readPersistentCache(
  ref: FigmaFrameRef,
  scale: number
): Promise<string | null> {
  const path = persistentCachePath(ref, scale);
  try {
    const file = getStorage().bucket().file(path);
    const [metadata] = await file.getMetadata(); // throws if object missing → miss
    // Manually seeded "pinned" objects are exempt from the TTL. For a persistent
    // cache without spending quota: export the frame as PNG @2x from the Figma app,
    // upload it to this path, and add custom metadata pinned=true. Automatic renders
    // do not set pinned → subject to the TTL.
    const pinned = metadata.metadata?.pinned === "true";
    const createdAt = metadata.timeCreated ? Date.parse(metadata.timeCreated) : 0;
    if (!pinned && (!createdAt || Date.now() - createdAt > FIGMA_PERSISTENT_CACHE_TTL_MS)) {
      logger.info("Figma persistent cache stale", { path });
      return null;
    }
    if (pinned) logger.info("Figma persistent cache pinned (TTL bypass)", { path });
    const [buffer] = await file.download();
    logger.info("Figma persistent cache hit (L2)", { path });
    return buffer.toString("base64");
  } catch (e) {
    logger.info("Figma persistent cache miss", {
      path,
      reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function writePersistentCache(
  ref: FigmaFrameRef,
  scale: number,
  base64: string
): Promise<void> {
  const path = persistentCachePath(ref, scale);
  try {
    const file = getStorage().bucket().file(path);
    await file.save(Buffer.from(base64, "base64"), {
      resumable: false,
      metadata: { contentType: "image/png" },
    });
    logger.info("Figma persistent cache written", { path });
  } catch (e) {
    logger.warn("Figma persistent cache write failed", {
      path,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function fetchFigmaImageDataURL(
  ref: FigmaFrameRef,
  token: string
): Promise<{ base64: string; mediaType: "image/png" }> {
  const imagesURL = new URL(`https://api.figma.com/v1/images/${ref.fileId}`);
  imagesURL.searchParams.set("ids", ref.nodeId);
  imagesURL.searchParams.set("format", "png");
  imagesURL.searchParams.set("scale", String(FIGMA_IMAGE_SCALE));

  const cacheKey = `${ref.fileId}:${ref.nodeId}:${FIGMA_IMAGE_SCALE}`;
  const cached = figmaImageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info("Figma image cache hit (L1)", { cacheKey });
    return { base64: cached.base64, mediaType: cached.mediaType };
  }

  // L1 miss → check the persistent (Storage) cache. On a hit, also fill L1 and
  // return; this protects the scarce /v1/images quota without hitting Figma at all.
  const persisted = await readPersistentCache(ref, FIGMA_IMAGE_SCALE);
  if (persisted) {
    figmaImageCache.set(cacheKey, {
      base64: persisted,
      mediaType: "image/png",
      expiresAt: Date.now() + FIGMA_IMAGE_CACHE_TTL_MS,
    });
    return { base64: persisted, mediaType: "image/png" };
  }

  // Single call — NO retry on 429. The /v1/images limit is very low (~6/month
  // on a View/Collab seat); retrying wastes the scarce quota, so fail fast.
  const response = await fetch(imagesURL.toString(), {
    headers: { "X-Figma-Token": token },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 429 diagnosis lives in the headers: X-Figma-Rate-Limit-Type "low" = View/Collab
    // seat (6/month, PERSISTENT problem → needs a Dev/Full token + file on a paid plan) ·
    // "high" = Dev/Full seat (per-minute limit, TEMPORARY → wait Retry-After).
    // X-Figma-Plan-Tier shows the plan the file lives on (starter/pro/org/...).
    logger.warn("Figma /v1/images non-OK", {
      status: response.status,
      rateLimitType: response.headers.get("x-figma-rate-limit-type"),
      retryAfter: response.headers.get("retry-after"),
      planTier: response.headers.get("x-figma-plan-tier"),
      bodySnippet: body.slice(0, 200),
    });
    throw new HttpsError(
      mapFigmaStatusToCode(response.status),
      response.status === 429
        ? "Figma render kotası aşıldı (429). /v1/images limiti düşüktür — " +
            "Dev/Full koltuklu bir token kullanın ya da kota yenilenince deneyin."
        : `Figma API ${response.status} döndü: ${body.slice(0, 200)}`
    );
  }
  const json = (await response.json()) as {
    err?: string;
    images: Record<string, string | null>;
  };
  if (json.err) {
    throw new HttpsError("unavailable", `Figma API hatası: ${json.err}`);
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
      "unavailable",
      `Figma CDN ${imgResponse.status} döndü (PNG indirilemedi).`
    );
  }
  const arrayBuffer = await imgResponse.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FIGMA_IMAGE_BYTES) {
    throw new HttpsError(
      "resource-exhausted",
      `Figma image too large (${arrayBuffer.byteLength} bytes).`
    );
  }
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  if (figmaImageCache.size > 50) figmaImageCache.clear();
  figmaImageCache.set(cacheKey, {
    base64,
    mediaType: "image/png",
    expiresAt: Date.now() + FIGMA_IMAGE_CACHE_TTL_MS,
  });
  // Also write to the persistent cache. await is REQUIRED: the instance may
  // freeze after the response returns, leaving a fire-and-forget upload half
  // done. Errors are swallowed inside writePersistentCache; main flow unaffected.
  await writePersistentCache(ref, FIGMA_IMAGE_SCALE, base64);
  return { base64, mediaType: "image/png" };
}

export const figmaCompare = onCall<FigmaCompareRequest, Promise<FigmaCompareResponseBody>>(
  {
    secrets: [anthropicApiKey, githubToken, figmaToken],
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

    // Two modes: (1) the client sends the PNG directly (imageBase64) → Figma is
    // NEVER hit, no quota issue. (2) figmaURL is given → render via /v1/images.
    // imageBase64 takes precedence; figmaURL is only required when it is absent.
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

    logger.info("figmaCompare request received", {
      mode: hasDirectImage ? "direct-image" : "figma-render",
      fileId: figmaRef?.fileId,
      nodeId: figmaRef?.nodeId,
      screenIdentifier,
    });

    try {
      // Determine the image source: directly uploaded PNG or Figma render.
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
        logger.info("figmaCompare using client image (Figma bypassed)", {
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
        // Unreachable (validated above) — kept for type safety.
        throw new HttpsError(
          "invalid-argument",
          "Geçerli bir imageBase64 ya da figmaURL sağlanmadı."
        );
      }

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

    // Prompt caching — render order: tools → system → messages. The cache_control
    // breakpoint at the end of the system block caches tools + system together.
    // (Sonnet's min cache prefix is 2048 tokens; system prompt + tools exceed it.)
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];

    // Message-level breakpoints (max 4 per request). STATIC: the first user turn
    // (the large Figma image) — written once, read for ~15 iterations. ROLLING: the
    // latest message — incrementally caches the growing conversation prefix (file
    // contents read so far). Before each call we strip the old ones and reapply
    // so the limit of 4 is never exceeded.
    type Cacheable = { cache_control?: { type: "ephemeral" } };
    const applyMessageCaching = (msgs: Anthropic.MessageParam[]): void => {
      for (const m of msgs) {
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            delete (block as Cacheable).cache_control;
          }
        }
      }
      const markLast = (m: Anthropic.MessageParam | undefined): void => {
        if (!m || !Array.isArray(m.content) || m.content.length === 0) return;
        (m.content[m.content.length - 1] as Cacheable).cache_control = {
          type: "ephemeral",
        };
      };
      markLast(msgs[0]);
      markLast(msgs[msgs.length - 1]);
    };

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
          figmaRef
            ? `Figma frame: file=${figmaRef.fileId}, node=${figmaRef.nodeId}`
            : "Figma görseli: kullanıcı tarafından doğrudan yüklendi (URL yok).",
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

      // FORCE report_differences on the last allowed turn: even if the agent burns
      // all iterations exploring/reading, the loop never ends without a report (this
      // was the root cause of the old "INTERNAL" error).
      const forceReport = iterations >= MAX_AGENT_ITERATIONS;
      const toolChoice: Anthropic.MessageCreateParamsNonStreaming["tool_choice"] =
        forceReport ? { type: "tool", name: "report_differences" } : undefined;

      applyMessageCaching(messages);
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_PER_RESPONSE,
        system: systemBlocks,
        tools,
        tool_choice: toolChoice,
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
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      });

      if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
        if (reported) break;
        // The model ended its turn without reporting: append its reply and explicitly
        // ask for the report on the next turn. We try to recover instead of throwing;
        // the next turn (the final one if needed) will force report_differences anyway.
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Henüz report_differences çağırmadın. Topladığın bilgilerle ŞİMDİ " +
                "report_differences tool'unu çağır — başka tool çağırma, düz metin yazma.",
            },
          ],
        });
        continue;
      }

      if (response.stop_reason !== "tool_use") {
        throw new HttpsError(
          "failed-precondition",
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

      // If a tool call was made and the last one was report_differences, the agent loop can end.
      if (reported) {
        // We return directly instead of giving Claude one more turn and waiting for
        // end_turn — the moment report_differences is called, the work is done.
        break;
      }
    }

    if (!reported) {
      throw new HttpsError(
        "failed-precondition",
        `figmaCompare ${iterations} turda rapor üretemedi. Ekran beklenenden karmaşık ` +
          "olabilir ya da model raporu tamamlayamadı; lütfen tekrar deneyin."
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
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("figmaCompare failed", { message });
      // NOTE: the "internal" code is masked by the iOS Firebase Functions SDK —
      // the server message is dropped and the user only sees "INTERNAL"
      // (FunctionsError.swift: status=="INTERNAL" => message/details are ignored).
      // We use "unavailable" so the message reaches the client
      // (transient / retryable error semantics).
      throw new HttpsError("unavailable", `figmaCompare hatası: ${message}`);
    }
  }
);
