import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

const CLAUDE_MODEL = "claude-sonnet-4-6";
// propose_change embeds the full file in newContent; Swift files easily
// blow past 4K output tokens, so we give Claude plenty of headroom.
const MAX_TOKENS_PER_RESPONSE = 16384;
const MAX_AGENT_ITERATIONS = 16;
export const MAX_BUG_DESCRIPTION_LENGTH = 5000;
export const MAX_PROPOSED_FILE_BYTES = 200_000;
// Activity timeline is appended to the user prompt as extra context; cap it so a
// runaway client can't blow up our token bill.
const MAX_ACTIVITY_LOG_CHARS = 4000;

const SYSTEM_PROMPT = `Sen kıdemli bir iOS geliştirici (Swift, UIKit) AI asistanısın.
Görevin: Bu iOS uygulamasıyla ilgili bug raporlarını okuyup, GitHub'daki kaynak kodu inceleyerek root cause'u bulup somut fix önermek VE düzeltmeyi tool ile teklif etmek.

iOS uygulama kaynakları repo içinde "{{IOS_SOURCE_ROOT}}" dizini altında bulunur. Analizi orada başlat.

Yaklaşım:
1. Önce iOS kaynak dizinini list_files ile keşfet
2. Şüpheli görünen dosyaları read_file ile oku (TAM dosya içeriğini almak şart, çünkü propose_change için yeni içeriği komple yazacaksın)
3. Root cause'u tespit et — varsayım yapma, koda bak
4. Her düzeltilmesi gereken dosya için propose_change tool'unu çağır. Tek bir fix birden çok dosyaya yayılabilir; her dosya için ayrı bir propose_change yap.
5. Tüm propose_change çağrılarından SONRA cevabı text olarak özetle.

propose_change kuralları:
- newContent: dosyanın YENİ tam içeriği (bütün dosya, sadece diff veya parça değil)
- description: kullanıcının kartta göreceği kısa Türkçe açıklama (örn. "guard let ile force-unwrap kaldırıldı")
- Sadece okuduğun dosyalar için çağır
- Aynı dosya için birden fazla çağrı yapma (tek seferde tüm değişiklikleri içeren newContent ver)

ÖNEMLİ — Cevap formatı (propose_change çağrılarından sonra):
Cevabını İKİ kısma ayır. Aralarına TAM olarak şu ayracı koy:
\`---TEKNİK---\`

Üst kısım (ayracın üstü) — yazılımcı olmayan kullanıcı için:
- 2-4 cümlelik sade Türkçe özet
- "Sorun: ...\\nÇözüm: ..." benzeri yapı kullanabilirsin
- Teknik terim, dosya adı, kod satırı, sınıf adı KULLANMA
- Kullanıcı bu kısmı görecek, anlayabilmeli

Alt kısım (ayracın altı) — yazılımcı için:
- ## Root Cause: (problem ne)
- ## Affected Files: (hangi dosyalar)
- ## Why: (neden bu fix işe yarar)
(Kod değişiklikleri propose_change kartlarında görünecek; burada diff tekrarlama.)

Örnek:
\`\`\`
Uygulamanın giriş ekranında "Devam" butonuna basıldığında bazen tepki vermediğini fark ettim. Bunun nedeni butonun aynı anda iki kez tetiklenebilmesiydi; tek seferlik bir kilit ekleyerek bu durumu çözdüm.

---TEKNİK---

## Root Cause
LoginViewController.didTapContinue() içinde isLoading flag kontrolü yoktu, bu yüzden hızlı çift tıklamada iki ayrı async login isteği başlıyordu.

## Affected Files
- ClaudeBugPoC/Scenes/Login/LoginViewController.swift

## Why
guard !isLoading else { return } koruması, butonun pending request bittiğinde tekrar enable edilmesi için viewDidLoad'da bağlanan delegate ile birlikte race condition'ı kapatır.
\`\`\`

Önemli:
- Tahmin etme, sadece okuduğun koda dayanarak konuş
- Eğer yetersiz bilgi varsa dosya oku, sorma
- Cevabın Türkçe olsun
- Ayracı (\`---TEKNİK---\`) MUTLAKA koy, frontend bu ayraca göre cevabı bölüyor`;

const tools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List files and directories at the given path in the GitHub repository. Use empty string for root directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to repo root (e.g. '' for root, 'ClaudeBugPoC' for the iOS app sources)",
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
          description: "File path relative to repo root (e.g. 'ClaudeBugPoC/ViewController.swift')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_change",
    description: "Register a proposed fix for a single file. The user will see this as a card with ✓/✗ buttons. Provide the FULL new file content, not a diff.",
    input_schema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Path of the file to change, relative to repo root (e.g. 'ClaudeBugPoC/ViewController.swift'). Must be a file you've already read.",
        },
        description: {
          type: "string",
          description: "Short Turkish summary of what this change does (will be shown on the change card).",
        },
        newContent: {
          type: "string",
          description: "The COMPLETE new file content after the fix. Not a diff, the entire file.",
        },
      },
      required: ["filePath", "description", "newContent"],
    },
    cache_control: { type: "ephemeral" },
  },
];

/**
 * Validates and trims the client-supplied activity log. Returns `undefined` if
 * the input is missing, the wrong type, or empty after trimming. Truncates to
 * MAX_ACTIVITY_LOG_CHARS to bound token spend.
 */
export function sanitizeActivityLog(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= MAX_ACTIVITY_LOG_CHARS) return trimmed;
  return trimmed.slice(0, MAX_ACTIVITY_LOG_CHARS) + "\n…[truncated]";
}

export interface ProposedChange {
  id: string;
  filePath: string;
  description: string;
  oldContent: string;
  newContent: string;
}

export interface BugReportResponse {
  answer: string;
  proposedChanges: ProposedChange[];
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
}

export interface RunBugAnalysisOptions {
  bugDescription: string;
  /** Optional iOS-side activity timeline (already sanitized/trimmed). */
  activityLog?: string;
  anthropic: Anthropic;
  octokit: Octokit;
  owner: string;
  repo: string;
  sourceRoot: string;
  /**
   * Called at the start of each agent iteration with the 1-based iteration
   * number. Used by the async job to stream live progress into Firestore.
   * Errors thrown here are ignored so progress reporting can never abort the run.
   */
  onProgress?: (iterations: number) => Promise<void> | void;
}

/**
 * Runs the agentic bug-analysis loop: Claude explores the GitHub repo via tools,
 * reads files, and registers proposed fixes, then returns a structured response.
 *
 * Transport-agnostic — throws plain `Error`s (never `HttpsError`). Callers map
 * failures to whatever their transport needs (HttpsError for callables, a job
 * status for the async worker).
 */
export async function runBugAnalysis(opts: RunBugAnalysisOptions): Promise<BugReportResponse> {
  const { bugDescription, activityLog, anthropic, octokit, owner, repo, sourceRoot, onProgress } = opts;

  const fileCache = new Map<string, string>();

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
      fileCache.set(path, decoded);
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

  const proposedChanges: ProposedChange[] = [];

  const registerProposal = (input: {
    filePath: string;
    description: string;
    newContent: string;
  }): string => {
    if (!input.filePath || !input.newContent || !input.description) {
      return "Error: filePath, description and newContent are all required.";
    }
    if (Buffer.byteLength(input.newContent, "utf-8") > MAX_PROPOSED_FILE_BYTES) {
      return `Error: newContent exceeds max size (${MAX_PROPOSED_FILE_BYTES} bytes).`;
    }
    const oldContent = fileCache.get(input.filePath);
    if (oldContent === undefined) {
      return `Error: '${input.filePath}' has not been read yet. Call read_file on it first so the diff is accurate.`;
    }
    if (oldContent === input.newContent) {
      return `Error: newContent is identical to current file content for '${input.filePath}'. Skip the proposal.`;
    }
    if (proposedChanges.some((c) => c.filePath === input.filePath)) {
      return `Error: '${input.filePath}' already has a proposed change. Combine all edits into one propose_change call per file.`;
    }
    const id = `chg_${proposedChanges.length + 1}`;
    proposedChanges.push({
      id,
      filePath: input.filePath,
      description: input.description,
      oldContent,
      newContent: input.newContent,
    });
    return `OK: registered proposal ${id} for ${input.filePath}.`;
  };

  const systemPrompt = SYSTEM_PROMPT.replace("{{IOS_SOURCE_ROOT}}", sourceRoot);

  const userContentParts = [
    `GitHub repo: ${owner}/${repo}`,
    `iOS kaynak dizini: ${sourceRoot}`,
    "",
    "Bug raporu:",
    bugDescription,
  ];
  if (activityLog) {
    userContentParts.push(
      "",
      "Kullanıcının son aktivitesi (T-Xs = bug gönderiminden X saniye önce):",
      "```",
      activityLog,
      "```",
      "Bu log'u kullanarak hangi ekrandaydı, hangi API çağrıları başarısız oldu, hangi butona dokundu sorularına cevap verebilirsin. Tahmin değil veri.",
    );
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: userContentParts.join("\n"),
    },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let iterations = 0;

  const reportProgress = async (iter: number): Promise<void> => {
    if (!onProgress) return;
    try {
      await onProgress(iter);
    } catch (e) {
      // Progress reporting is best-effort — never let it abort the analysis.
      logger.warn("onProgress callback failed", {
        iteration: iter,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;
    await reportProgress(iterations);

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS_PER_RESPONSE,
      system: [
        {
          type: "text",
          text: systemPrompt,
        },
      ],
      tools,
      messages,
    });

    const usage = response.usage as Anthropic.Usage & {
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;

    totalInputTokens += usage.input_tokens;
    totalOutputTokens += usage.output_tokens;
    totalCacheCreationTokens += cacheCreate;
    totalCacheReadTokens += cacheRead;

    logger.info("Claude iteration", {
      iteration: iterations,
      stopReason: response.stop_reason,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: cacheCreate,
      cacheReadTokens: cacheRead,
      proposalsSoFar: proposedChanges.length,
    });

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      const textBlock = response.content.find((b) => b.type === "text");
      let answer =
        textBlock && textBlock.type === "text"
          ? textBlock.text
          : "(Claude bir cevap üretemedi)";
      if (response.stop_reason === "max_tokens") {
        answer +=
          "\n\n⚠️ Cevap max_tokens limitine takıldı — bazı önerilen değişiklikler eksik olabilir.";
        logger.warn("Claude hit max_tokens", {
          iteration: iterations,
          outputTokens: response.usage.output_tokens,
        });
      }

      // Sonnet 4.x pricing per 1M tokens:
      //   input  $3.00  ·  output $15.00
      //   cache write (5min) $3.75  ·  cache read $0.30
      const estimatedCostUsd =
        (totalInputTokens / 1_000_000) * 3 +
        (totalCacheCreationTokens / 1_000_000) * 3.75 +
        (totalCacheReadTokens / 1_000_000) * 0.3 +
        (totalOutputTokens / 1_000_000) * 15;

      return {
        answer,
        proposedChanges,
        iterations,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
      };
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
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
      } else if (block.name === "propose_change") {
        const input = block.input as {
          filePath: string;
          description: string;
          newContent: string;
        };
        result = registerProposal(input);
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

  // Döngü tüm iterasyonları tüketti (nadiren). Throw etmek yerine o ana kadar
  // toplanan önerilerle kısmi bir cevap dön — kullanıcı çıplak "INTERNAL"
  // yerine anlamlı bir sonuç görsün.
  logger.warn("runBugAnalysis hit iteration cap", {
    iterations,
    proposalsSoFar: proposedChanges.length,
  });
  const partialCostUsd =
    (totalInputTokens / 1_000_000) * 3 +
    (totalCacheCreationTokens / 1_000_000) * 3.75 +
    (totalCacheReadTokens / 1_000_000) * 0.3 +
    (totalOutputTokens / 1_000_000) * 15;
  return {
    answer:
      proposedChanges.length > 0
        ? "Analiz adım sınırına ulaştı ve tam tamamlanamadı, ama bulabildiğim " +
          "önerileri aşağıda görebilirsin. Daha kesin sonuç için sorunu biraz " +
          "daha belirgin (hangi ekran, ne zaman) anlatıp tekrar deneyebilirsin."
        : "Analiz adım sınırına ulaştı ve sonuç üretemedi. Lütfen sorunu biraz " +
          "daha belirgin (hangi ekran, ne yapınca) anlatıp tekrar dener misin?",
    proposedChanges,
    iterations,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    estimatedCostUsd: Math.round(partialCostUsd * 10000) / 10000,
  };
}
