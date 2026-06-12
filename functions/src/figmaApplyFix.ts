import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const githubToken = defineSecret("GITHUB_TOKEN");

const githubOwner = defineString("GITHUB_OWNER", { default: "emrebuyuker" });
const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-ios-client" });
const iosSourceRoot = defineString("IOS_SOURCE_ROOT", { default: "ClaudeBugPoC" });
const baseBranch = defineString("PR_BASE_BRANCH", { default: "main" });

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_PER_RESPONSE = 8192;
const MAX_AGENT_ITERATIONS = 16;
const MAX_FILE_BYTES = 200_000;
const MAX_FIELD_LENGTH = 2000;

const SYSTEM_PROMPT = `Sen kıdemli bir iOS / UIKit / SnapKit geliştiricisin. Görevin: Figma karşılaştırmasında bulunan TEK bir tasarım farkını gidermek için iOS Swift kodunda küçük, hedefli bir düzenleme önermek.

iOS uygulama kaynakları "{{IOS_SOURCE_ROOT}}" dizini altında, UIKit + SnapKit + Layoutable/Layouting protokol stack'i kullanıyor.

Yaklaşım:
1. Kullanıcı sana hangi ekranı (VC tip adı, ör. "TestDetayViewController") ve hangi farkı düzelteceğini söyleyecek.
2. list_files ile Scenes/<ScreenName>/ altını keşfet (codeHint ipucundaki dosya adını arayarak başla).
3. read_file ile ilgili dosyaların tam içeriğini oku. Birden çok dosya okuyacaksan TEK turda paralel read_file çağrıları yap; gereksiz keşfe dalma — tur bütçen sınırlı, dağılırsan düzenleme üretemeden tükenirsin.
4. Tek bir dosyada gerekli minimum değişikliği tasarla. Kod stilini, import'ları, MARK comment'ları koru.
5. propose_edit tool'unu çağır — newContent dosyanın TAM yeni içeriği olmalı (whole file).

propose_edit kuralları:
- filePath: değiştirilen dosyanın repo köküne göre tam yolu (ör. "ClaudeBugPoC/Scenes/TestDetay/TestDetayView.swift").
- newContent: dosyanın komple yeni içeriği. Mevcut dosyanın çoğunluğunu aynen koru; sadece gerekli satırları değiştir.
- description: 1-2 cümlelik Türkçe açıklama, ne değiştirdiğini ve neden değiştirdiğini söyle.
- propose_edit'i sadece BİR KEZ çağır — son çağrı olarak. Sonrasında text üretme.

Önemli:
- Sadece bir dosyayı düzenle (multi-file değişiklikleri reddet).
- Değiştirmediğin satırları aynen koru — diff küçük olsun.
- Dosyayı kısaltma, kesme, "..." ile placeholder bırakma.
- Türkçe açıklama, kod İngilizce.`;

const tools: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List files and directories at the given path in the GitHub repository.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to repo root.",
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
    name: "propose_edit",
    description: "Submit the proposed single-file edit. Call this exactly once as your final action.",
    input_schema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "File path relative to repo root.",
        },
        newContent: {
          type: "string",
          description: "Complete new content of the file (not a diff).",
        },
        description: {
          type: "string",
          description: "Short Turkish description of what was changed and why.",
        },
      },
      required: ["filePath", "newContent", "description"],
    },
  },
];

interface FigmaApplyFixRequest {
  screenIdentifier: string;
  differenceTitle: string;
  differenceDetail: string;
  differenceCategory?: string;
  codeHint?: string;
}

interface FigmaApplyFixResponse {
  prUrl: string;
  prNumber: number;
  branch: string;
  filePath: string;
  description: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface ProposedEdit {
  filePath: string;
  newContent: string;
  description: string;
}

const sanitizeBranchSegment = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "fix";
};

const truncate = (s: string, max: number): string => {
  return s.length > max ? s.slice(0, max) + "…" : s;
};

async function openPRForEdit(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  edit: ProposedEdit,
  title: string,
  body: string
): Promise<{ prUrl: string; prNumber: number; branch: string; commitSha: string }> {
  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
  const baseCommitSha = baseRef.data.object.sha;

  const baseCommit = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: baseCommitSha,
  });
  const baseTreeSha = baseCommit.data.tree.sha;

  const blob = await octokit.git.createBlob({
    owner,
    repo,
    content: Buffer.from(edit.newContent, "utf-8").toString("base64"),
    encoding: "base64",
  });

  const newTree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: [
      {
        path: edit.filePath,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      },
    ],
  });

  const newCommit = await octokit.git.createCommit({
    owner,
    repo,
    message: `fix: ${title}\n\n${edit.description}\n\nChanged file:\n- ${edit.filePath}`,
    tree: newTree.data.sha,
    parents: [baseCommitSha],
  });

  const branchName = `claude/figma-fix-${sanitizeBranchSegment(title)}-${Date.now()}`;
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: newCommit.data.sha,
  });

  const pr = await octokit.pulls.create({
    owner,
    repo,
    title: `fix: ${title}`.slice(0, 100),
    head: branchName,
    base,
    body,
  });

  return {
    prUrl: pr.data.html_url,
    prNumber: pr.data.number,
    branch: branchName,
    commitSha: newCommit.data.sha,
  };
}

export const figmaApplyFix = onCall<FigmaApplyFixRequest, Promise<FigmaApplyFixResponse>>(
  {
    secrets: [anthropicApiKey, githubToken],
    maxInstances: 3,
    timeoutSeconds: 540,
    memory: "512MiB",
    region: "us-central1",
    // TODO: enforceAppCheck: true — enable once iOS App Attest is rolled out.
  },
  async (
    request: CallableRequest<FigmaApplyFixRequest>
  ): Promise<FigmaApplyFixResponse> => {
    const {
      screenIdentifier,
      differenceTitle,
      differenceDetail,
      differenceCategory,
      codeHint,
    } = request.data;

    if (!screenIdentifier || typeof screenIdentifier !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "screenIdentifier zorunlu (string)."
      );
    }
    if (!differenceTitle || typeof differenceTitle !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "differenceTitle zorunlu (string)."
      );
    }
    if (!differenceDetail || typeof differenceDetail !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "differenceDetail zorunlu (string)."
      );
    }
    if (screenIdentifier.length > 120) {
      throw new HttpsError("invalid-argument", "screenIdentifier çok uzun.");
    }

    const owner = githubOwner.value();
    const repo = githubRepo.value();
    const sourceRoot = iosSourceRoot.value();
    const base = baseBranch.value();
    if (owner === "REPLACE_ME") {
      throw new HttpsError(
        "failed-precondition",
        "GITHUB_OWNER param is not configured."
      );
    }

    const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });
    const octokit = new Octokit({ auth: githubToken.value() });

    logger.info("figmaApplyFix request received", {
      screenIdentifier,
      differenceTitle: truncate(differenceTitle, 200),
    });

    try {
    const readGitHubFile = async (path: string): Promise<string> => {
      try {
        const response = await octokit.repos.getContent({ owner, repo, path });
        if (Array.isArray(response.data)) {
          return `Error: '${path}' is a directory. Use list_files.`;
        }
        if (response.data.type !== "file" || !("content" in response.data)) {
          return `Error: '${path}' is not a readable file.`;
        }
        const decoded = Buffer.from(response.data.content, "base64").toString(
          "utf-8"
        );
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
          .map(
            (item) =>
              `${item.type === "dir" ? "[dir]" : "[file]"} ${item.path}`
          )
          .join("\n");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error listing '${path}': ${msg}`;
      }
    };

    let proposedEdit: ProposedEdit | null = null;

    const recordEdit = (input: ProposedEdit): string => {
      if (proposedEdit) {
        return "Error: propose_edit was already called. Do not call it again.";
      }
      if (!input.filePath || !input.newContent || !input.description) {
        return "Error: filePath, newContent and description are all required.";
      }
      if (Buffer.byteLength(input.newContent, "utf-8") > MAX_FILE_BYTES) {
        return `Error: newContent exceeds max size (${MAX_FILE_BYTES} bytes).`;
      }
      if (!input.filePath.startsWith(sourceRoot)) {
        return `Error: filePath must be inside ${sourceRoot}.`;
      }
      proposedEdit = input;
      return "OK: edit recorded. End your turn now.";
    };

    const systemPrompt = SYSTEM_PROMPT.replace(
      /\{\{IOS_SOURCE_ROOT\}\}/g,
      sourceRoot
    );

    // Prompt caching — render order: tools → system → messages. The cache_control
    // breakpoint at the end of the system block caches tools + system together.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];

    // Message-level breakpoints (max 4 per request). STATIC: the first user turn.
    // ROLLING: the latest message — incrementally caches the growing conversation
    // prefix (Swift files read) so it isn't resent at full price every iteration.
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

    const userText = [
      `GitHub repo: ${owner}/${repo}`,
      `iOS kaynak dizini: ${sourceRoot}`,
      `Ekran (VC tip adı): ${screenIdentifier}`,
      "",
      "Düzeltilecek fark:",
      `- Başlık: ${truncate(differenceTitle, MAX_FIELD_LENGTH)}`,
      `- Detay: ${truncate(differenceDetail, MAX_FIELD_LENGTH)}`,
      differenceCategory ? `- Kategori: ${differenceCategory}` : "",
      codeHint ? `- Kod ipucu: ${truncate(codeHint, MAX_FIELD_LENGTH)}` : "",
      "",
      "Önce ilgili Scene dosyalarını keşfedip oku, sonra propose_edit ile " +
        "tek dosyalık tam içerikli bir düzenleme öner. propose_edit son tool " +
        "çağrın olmalı.",
    ]
      .filter(Boolean)
      .join("\n");

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: userText }] },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let iterations = 0;

    while (iterations < MAX_AGENT_ITERATIONS) {
      iterations++;

      applyMessageCaching(messages);
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_PER_RESPONSE,
        system: systemBlocks,
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

      logger.info("figmaApplyFix iteration", {
        iteration: iterations,
        stopReason: response.stop_reason,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      });

      if (
        response.stop_reason === "end_turn" ||
        response.stop_reason === "max_tokens"
      ) {
        if (proposedEdit) break;
        // Model ended its turn without calling propose_edit: instead of throwing,
        // give it one more turn and ask for the tool explicitly. We do NOT force
        // propose_edit via tool_choice — if it hasn't read the file yet it could
        // fabricate full-file content and open a broken PR; leaving it free to
        // read files is safer.
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Henüz propose_edit çağırmadın. Gerekli dosyaları okuduysan ŞİMDİ " +
                "propose_edit ile tam dosya içerikli düzenlemeni gönder; eksik bilgi " +
                "varsa önce read_file ile oku.",
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
        } else if (block.name === "propose_edit") {
          const input = block.input as ProposedEdit;
          result = recordEdit(input);
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

      if (proposedEdit) {
        break;
      }
    }

    if (!proposedEdit) {
      throw new HttpsError(
        "failed-precondition",
        `figmaApplyFix ${iterations} turda bir düzenleme üretemedi. ` +
          "Fark çok karmaşık olabilir ya da model dosyayı bulamadı; lütfen tekrar deneyin."
      );
    }

    const edit: ProposedEdit = proposedEdit;

    const prBody = [
      "## Figma Karşılaştırma Düzeltmesi",
      "",
      `**Ekran:** ${screenIdentifier}`,
      `**Fark:** ${differenceTitle}`,
      "",
      "**Detay:**",
      differenceDetail,
      "",
      "**Claude'un Açıklaması:**",
      edit.description,
      "",
      "---",
      "*Bu PR Figma karşılaştırma ekranında \"Düzenle\" butonuyla tetiklendi.*",
    ].join("\n");

    const created = await openPRForEdit(
      octokit,
      owner,
      repo,
      base,
      edit,
      differenceTitle,
      prBody
    );

    logger.info("figmaApplyFix PR created", {
      prNumber: created.prNumber,
      branch: created.branch,
      filePath: edit.filePath,
    });

    // Pricing — Sonnet 4.x per 1M tokens:
    //   input $3.00 · output $15.00 · cache write $3.75 · cache read $0.30
    const estimatedCostUsd =
      (totalInputTokens / 1_000_000) * 3 +
      (totalCacheCreationTokens / 1_000_000) * 3.75 +
      (totalCacheReadTokens / 1_000_000) * 0.3 +
      (totalOutputTokens / 1_000_000) * 15;

    return {
      prUrl: created.prUrl,
      prNumber: created.prNumber,
      branch: created.branch,
      filePath: edit.filePath,
      description: edit.description,
      iterations,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 10000) / 10000,
    };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("figmaApplyFix failed", { message });
      // NOTE: the "internal" code is masked by the iOS Firebase Functions SDK
      // (the server message is dropped and the user only sees "INTERNAL"). We use
      // "unavailable" so the message is visible on the client.
      throw new HttpsError("unavailable", `figmaApplyFix hatası: ${message}`);
    }
  }
);
