import { onRequest, onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { sanitizeActivityLog } from "./askClaude";

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const jiraEmail = defineSecret("JIRA_EMAIL");
const jiraApiToken = defineSecret("JIRA_API_TOKEN");
const appPassword = defineSecret("APP_PASSWORD");

const jiraDomain = defineString("JIRA_DOMAIN", { default: "REPLACE_ME" });
const jiraProjectKey = defineString("JIRA_PROJECT_KEY", { default: "REPLACE_ME" });

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_PER_RESPONSE = 2048;
const MAX_USER_INPUT_LENGTH = 5000;

type JiraPriority = "Highest" | "High" | "Medium" | "Low" | "Lowest";

interface TicketDraft {
  summary: string;
  description: string;
  priority: JiraPriority;
  issueType: string;
  labels: string[];
}

const SYSTEM_PROMPT = `Sen bir Jira ticket asistanısın. Kullanıcı sana doğal dilde bir sorun, görev veya istek anlatır.
Görevin: Bu anlatımı düzgün bir Jira ticket'ına çevirmek ve create_ticket tool'unu çağırmak.

Bazı isteklerle birlikte "Kullanıcının son aktivitesi" başlığı altında, T-Xs (X saniye önce) zaman damgalı bir timeline gelir. Bu timeline gerçek veridir — varsa description'ı zenginleştirmek için kullan:
- Hangi ekrandaydı (SCREEN/NAV satırları)
- Hangi API çağrısı başarısız oldu (NET satırları, status >= 400 veya err= alanı olanlar)
- Hangi butona dokundu (TAP satırları)
- Hangi hata gördü (ALERT satırları)
Description'da bu bilgileri "Adımlar:" benzeri bir bölümle özetleyebilirsin. Timeline yoksa sadece kullanıcının yazdığı metne dayan.

Kurallar:
- summary: kısa ve anlamlı bir başlık (en fazla 100 karakter), kullanıcının dilinde
- description: detaylı açıklama, paragraflar halinde, Markdown KULLANMA (sadece düz metin ve paragraf ayırımı için boş satır). Eğer kullanıcı yeterli detay vermediyse, var olan bilgiyi (timeline dahil) yapılandırılmış şekilde yaz.
- priority: anlatımdaki aciliyete göre seç (Highest=kritik/prodda patlamış, High=önemli, Medium=normal, Low=ufak, Lowest=nice-to-have). Timeline'da 5xx hata varsa priority'yi bir kademe yukarı al.
- issueType: "Bug" (hata/bozuk şey), "Task" (yapılacak iş), "Story" (yeni özellik/kullanıcı isteği)
- labels: ilgili etiketler (en fazla 5, küçük harf, tire ile ayrı kelimeler — örn. "frontend", "auth-bug")

Sadece create_ticket tool'unu çağır, başka metin üretme.`;

const tools: Anthropic.Tool[] = [
  {
    name: "create_ticket",
    description: "Submit the parsed Jira ticket fields.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Short title for the ticket (max 100 chars).",
        },
        description: {
          type: "string",
          description: "Detailed description in plain text. Use blank lines to separate paragraphs.",
        },
        priority: {
          type: "string",
          enum: ["Highest", "High", "Medium", "Low", "Lowest"],
          description: "Jira priority level.",
        },
        issueType: {
          type: "string",
          enum: ["Bug", "Task", "Story"],
          description: "Type of issue.",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Relevant labels (lowercase, hyphen-separated). Max 5.",
        },
      },
      required: ["summary", "description", "priority", "issueType", "labels"],
    },
  },
];

function toAdf(plainText: string): unknown {
  const paragraphs = plainText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    paragraphs.push(plainText.trim() || "(no description)");
  }

  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  };
}

async function parseUserInputWithClaude(
  anthropic: Anthropic,
  userInput: string,
  activityLog?: string
): Promise<TicketDraft> {
  const userContent = activityLog
    ? `${userInput}\n\nKullanıcının son aktivitesi (T-Xs = ticket gönderiminden X saniye önce):\n\`\`\`\n${activityLog}\n\`\`\``
    : userInput;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS_PER_RESPONSE,
    system: SYSTEM_PROMPT,
    tools,
    tool_choice: { type: "tool", name: "create_ticket" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude create_ticket tool'unu çağırmadı.");
  }

  const input = toolUse.input as TicketDraft;

  if (!input.summary || input.summary.length > 200) {
    throw new Error("Claude geçersiz bir summary döndü.");
  }
  if (!input.description) {
    throw new Error("Claude description döndürmedi.");
  }
  if (!["Highest", "High", "Medium", "Low", "Lowest"].includes(input.priority)) {
    input.priority = "Medium";
  }
  if (!["Bug", "Task", "Story"].includes(input.issueType)) {
    input.issueType = "Task";
  }
  if (!Array.isArray(input.labels)) {
    input.labels = [];
  }
  input.labels = input.labels
    .filter((l) => typeof l === "string" && l.length > 0 && l.length < 50)
    .slice(0, 5)
    .map((l) => l.toLowerCase().replace(/\s+/g, "-"));

  return input;
}

async function getProjectIssueTypes(
  domain: string,
  projectKey: string,
  authHeader: string
): Promise<string[]> {
  const url = `https://${domain}/rest/api/3/project/${projectKey}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });
  if (!res.ok) {
    logger.warn("Issue type listesi alınamadı, fallback'e düşülüyor", {
      status: res.status,
    });
    return [];
  }
  const data = (await res.json()) as {
    issueTypes?: { name: string; subtask?: boolean }[];
  };
  return (data.issueTypes || [])
    .filter((t) => !t.subtask)
    .map((t) => t.name);
}

// Jira locale'ine göre issue type isimleri Türkçe veya İngilizce olabilir.
// Aynı anlamı taşıyan isimleri tek grupta tutuyoruz.
const ISSUE_TYPE_ALIASES: Record<string, string[]> = {
  bug: ["bug", "hata", "defect", "kusur"],
  task: ["task", "görev", "gorev", "iş"],
  story: ["story", "hikaye", "öykü", "oyku", "user story", "kullanıcı hikayesi"],
  epic: ["epic", "epik"],
  subtask: ["subtask", "alt görev", "alt gorev", "sub-task"],
};

function canonicalize(name: string): string {
  const lc = name.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(ISSUE_TYPE_ALIASES)) {
    if (aliases.includes(lc)) return canonical;
  }
  return lc;
}

function pickIssueType(requested: string, available: string[]): string {
  if (available.length === 0) return requested;

  // 1. Doğrudan eşleşme (case-insensitive)
  const direct = available.find(
    (t) => t.toLowerCase() === requested.toLowerCase()
  );
  if (direct) return direct;

  // 2. Anlam üzerinden eşleşme (Görev ↔ Task gibi)
  const requestedCanonical = canonicalize(requested);
  const aliasMatch = available.find(
    (t) => canonicalize(t) === requestedCanonical
  );
  if (aliasMatch) return aliasMatch;

  // 3. Tercih sırası: Task → Story → Bug → diğer (Epic'i hariç tut çünkü
  // sprint'e/board'a girmez)
  for (const pref of ["task", "story", "bug"]) {
    const found = available.find((t) => canonicalize(t) === pref);
    if (found) return found;
  }

  // 4. Son çare: epic ve subtask olmayan ilk type
  const nonSpecial = available.find((t) => {
    const c = canonicalize(t);
    return c !== "epic" && c !== "subtask";
  });
  if (nonSpecial) return nonSpecial;

  // 5. Hiçbir şey kalmadıysa ilkini al
  return available[0];
}

async function postToJira(
  draft: TicketDraft,
  domain: string,
  projectKey: string,
  email: string,
  apiToken: string
): Promise<{ key: string }> {
  const authHeader =
    "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

  const availableTypes = await getProjectIssueTypes(domain, projectKey, authHeader);
  const issueTypeName = pickIssueType(draft.issueType, availableTypes);
  if (issueTypeName !== draft.issueType) {
    logger.info("Issue type ayarlandı", {
      requested: draft.issueType,
      chosen: issueTypeName,
      available: availableTypes,
    });
    draft.issueType = issueTypeName;
  }

  const body = {
    fields: {
      project: { key: projectKey },
      summary: draft.summary,
      description: toAdf(draft.description),
      issuetype: { name: issueTypeName },
      priority: { name: draft.priority },
      labels: draft.labels,
    },
  };

  const url = `https://${domain}/rest/api/3/issue`;

  const send = async (payload: object) => {
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  };

  let response = await send(body);

  // Bazı Jira Cloud projelerinde "priority" alanı kapalı olur. Bu durumda
  // 400 dönüp "priority" hatası verir; tekrar prioritysiz deneriz.
  if (!response.ok && response.status === 400) {
    const errText = await response.clone().text();
    if (errText.toLowerCase().includes("priority")) {
      logger.info("priority alanı reddedildi, prioritysiz tekrar deneniyor");
      const retry = JSON.parse(JSON.stringify(body));
      delete retry.fields.priority;
      response = await send(retry);
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("Jira API hatası", {
      status: response.status,
      body: errorText,
    });
    throw new Error(`Jira ticket oluşturulamadı (${response.status}): ${errorText}`);
  }

  return (await response.json()) as { key: string };
}

async function addToActiveSprint(
  domain: string,
  projectKey: string,
  ticketKey: string,
  authHeader: string
): Promise<{ added: boolean; sprintName?: string }> {
  const jsonHeaders = { Authorization: authHeader, Accept: "application/json" };

  // 1. Projenin board(lar)ını bul. Team-managed projelerde board.type
  // farklı gelebilir, o yüzden type filtresi yapmıyoruz.
  const boardsUrl = `https://${domain}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`;
  const boardsRes = await fetch(boardsUrl, { headers: jsonHeaders });
  if (!boardsRes.ok) {
    logger.warn("Board listesi alınamadı", {
      status: boardsRes.status,
      body: await boardsRes.text(),
    });
    return { added: false };
  }
  const boardsData = (await boardsRes.json()) as {
    values?: { id: number; name?: string; type?: string }[];
  };
  const boards = boardsData.values || [];
  logger.info("Board listesi", {
    count: boards.length,
    boards: boards.map((b) => ({ id: b.id, type: b.type, name: b.name })),
  });

  if (boards.length === 0) {
    logger.info("Hiç board yok, sprint adımı atlandı");
    return { added: false };
  }

  // 2. Her board'da aktif sprint ara. İlk bulduğumuza ekliyoruz.
  for (const board of boards) {
    const sprintsUrl = `https://${domain}/rest/agile/1.0/board/${board.id}/sprint?state=active`;
    const sprintsRes = await fetch(sprintsUrl, { headers: jsonHeaders });
    if (!sprintsRes.ok) {
      // Kanban board'lar sprint endpoint'ini desteklemez (400/404 dönerler)
      logger.info("Board sprint desteklemiyor (muhtemelen kanban)", {
        boardId: board.id,
        boardType: board.type,
        status: sprintsRes.status,
      });
      continue;
    }
    const sprintsData = (await sprintsRes.json()) as {
      values?: { id: number; name: string; state: string }[];
    };
    const activeSprint = (sprintsData.values || [])[0];
    if (!activeSprint) {
      logger.info("Bu board'da aktif sprint yok", { boardId: board.id });
      continue;
    }

    // 3. Ticket'ı sprint'e ekle
    const addUrl = `https://${domain}/rest/agile/1.0/sprint/${activeSprint.id}/issue`;
    const addRes = await fetch(addUrl, {
      method: "POST",
      headers: {
        ...jsonHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ issues: [ticketKey] }),
    });
    if (!addRes.ok) {
      const errText = await addRes.text();
      logger.warn("Ticket sprint'e eklenemedi", {
        boardId: board.id,
        sprintId: activeSprint.id,
        status: addRes.status,
        body: errText,
      });
      continue;
    }

    logger.info("Ticket aktif sprint'e eklendi", {
      sprint: activeSprint.name,
      sprintId: activeSprint.id,
      boardId: board.id,
      ticket: ticketKey,
    });
    return { added: true, sprintName: activeSprint.name };
  }

  logger.info("Hiçbir board'da uygun aktif sprint bulunamadı");
  return { added: false };
}

// Sabit string karşılaştırması — timing attack'a karşı koruma.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export const createJiraTicket = onRequest(
  {
    secrets: [anthropicApiKey, jiraEmail, jiraApiToken, appPassword],
    maxInstances: 5,
    timeoutSeconds: 60,
    memory: "256MiB",
    region: "us-central1",
    cors: ["https://claude-bug-poc.web.app", "https://claude-bug-poc.firebaseapp.com"],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Sadece POST kabul edilir." });
      return;
    }

    // Şifre doğrulama. Hem expected hem provided şifreyi trim ediyoruz çünkü
    // Firebase secrets interactive prompt'tan trailing newline gelebiliyor.
    const providedPassword = (
      req.get("x-access-password") ||
      (typeof req.body === "object" && req.body !== null
        ? ((req.body as { password?: unknown }).password as string | undefined) || ""
        : "")
    ).trim();
    const expectedPassword = (appPassword.value() || "").trim();
    if (!expectedPassword || expectedPassword === "REPLACE_ME") {
      res.status(500).json({ error: "Sunucu yapılandırması eksik." });
      return;
    }
    if (!providedPassword || !timingSafeEqual(providedPassword, expectedPassword)) {
      logger.warn("Geçersiz şifre denemesi", {
        ip: req.ip,
        providedLen: providedPassword.length,
        expectedLen: expectedPassword.length,
      });
      res.status(401).json({ error: "Geçersiz şifre." });
      return;
    }

    try {
      const userInput =
        typeof req.body === "object" && req.body !== null
          ? (req.body as { userInput?: unknown }).userInput
          : undefined;

      if (typeof userInput !== "string") {
        res.status(400).json({ error: "userInput zorunlu (string)." });
        return;
      }
      if (userInput.trim().length < 5) {
        res.status(400).json({
          error: "Lütfen sorununuzu en az birkaç kelimeyle anlatın.",
        });
        return;
      }
      if (userInput.length > MAX_USER_INPUT_LENGTH) {
        res.status(400).json({
          error: `Açıklama çok uzun (en fazla ${MAX_USER_INPUT_LENGTH} karakter).`,
        });
        return;
      }

      const domain = jiraDomain.value();
      const projectKey = jiraProjectKey.value();
      if (domain === "REPLACE_ME" || projectKey === "REPLACE_ME") {
        res.status(500).json({
          error: "JIRA_DOMAIN ve JIRA_PROJECT_KEY parametreleri ayarlanmamış.",
        });
        return;
      }

      const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });

      logger.info("Ticket draft oluşturuluyor", {
        inputLength: userInput.length,
      });
      const draft = await parseUserInputWithClaude(anthropic, userInput);

      logger.info("Jira'ya gönderiliyor", {
        summary: draft.summary,
        priority: draft.priority,
        issueType: draft.issueType,
      });

      const created = await postToJira(
        draft,
        domain,
        projectKey,
        jiraEmail.value(),
        jiraApiToken.value()
      );

      const ticketUrl = `https://${domain}/browse/${created.key}`;
      logger.info("Ticket oluşturuldu", { key: created.key, url: ticketUrl });

      // Aktif sprint'e eklemeyi dene. Başarısız olursa ticket zaten oluştu,
      // backlog'da kalır — request'i fail etme.
      let sprintInfo: { added: boolean; sprintName?: string } = { added: false };
      try {
        const authHeader =
          "Basic " +
          Buffer.from(
            `${jiraEmail.value()}:${jiraApiToken.value()}`
          ).toString("base64");
        sprintInfo = await addToActiveSprint(
          domain,
          projectKey,
          created.key,
          authHeader
        );
      } catch (e) {
        logger.warn("Sprint atama hatası (ticket yine de oluştu)", {
          message: e instanceof Error ? e.message : String(e),
        });
      }

      res.status(200).json({
        ticketKey: created.key,
        ticketUrl,
        summary: draft.summary,
        description: draft.description,
        priority: draft.priority,
        issueType: draft.issueType,
        labels: draft.labels,
        sprintAdded: sprintInfo.added,
        sprintName: sprintInfo.sprintName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("createJiraTicket hata", { message });
      res.status(500).json({ error: message });
    }
  }
);

interface BugTicketRequest {
  bugDescription: string;
  /** Optional iOS-side activity timeline (compact "[T-Xs] TYPE target | k=v" lines). */
  activityLog?: string;
}

interface BugTicketResponse {
  ticketKey: string;
  ticketUrl: string;
  summary: string;
  priority: JiraPriority;
  issueType: string;
  labels: string[];
  sprintAdded: boolean;
  sprintName?: string;
}

export const createBugTicket = onCall<BugTicketRequest, Promise<BugTicketResponse>>(
  {
    secrets: [anthropicApiKey, jiraEmail, jiraApiToken],
    maxInstances: 5,
    timeoutSeconds: 60,
    memory: "256MiB",
    region: "us-central1",
    // TODO: enforceAppCheck: true — iOS App Attest devreye alındığında aç.
  },
  async (request: CallableRequest<BugTicketRequest>): Promise<BugTicketResponse> => {
    const { bugDescription, activityLog } = request.data;

    if (typeof bugDescription !== "string") {
      throw new HttpsError("invalid-argument", "bugDescription zorunlu (string).");
    }
    const trimmedActivityLog = sanitizeActivityLog(activityLog);
    if (bugDescription.trim().length < 5) {
      throw new HttpsError(
        "invalid-argument",
        "Lütfen sorununuzu en az birkaç kelimeyle anlatın."
      );
    }
    if (bugDescription.length > MAX_USER_INPUT_LENGTH) {
      throw new HttpsError(
        "invalid-argument",
        `Açıklama çok uzun (en fazla ${MAX_USER_INPUT_LENGTH} karakter).`
      );
    }

    const domain = jiraDomain.value();
    const projectKey = jiraProjectKey.value();
    if (domain === "REPLACE_ME" || projectKey === "REPLACE_ME") {
      throw new HttpsError(
        "failed-precondition",
        "JIRA_DOMAIN ve JIRA_PROJECT_KEY parametreleri ayarlanmamış."
      );
    }

    const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });

    try {
    logger.info("Bug ticket draft oluşturuluyor (callable)", {
      inputLength: bugDescription.length,
      hasActivityLog: !!trimmedActivityLog,
    });
    const draft = await parseUserInputWithClaude(
      anthropic,
      bugDescription,
      trimmedActivityLog
    );

    logger.info("Jira'ya gönderiliyor (callable)", {
      summary: draft.summary,
      priority: draft.priority,
      issueType: draft.issueType,
    });

    const created = await postToJira(
      draft,
      domain,
      projectKey,
      jiraEmail.value(),
      jiraApiToken.value()
    );

    const ticketUrl = `https://${domain}/browse/${created.key}`;
    logger.info("Bug ticket oluşturuldu (callable)", {
      key: created.key,
      url: ticketUrl,
    });

    let sprintInfo: { added: boolean; sprintName?: string } = { added: false };
    try {
      const authHeader =
        "Basic " +
        Buffer.from(`${jiraEmail.value()}:${jiraApiToken.value()}`).toString("base64");
      sprintInfo = await addToActiveSprint(domain, projectKey, created.key, authHeader);
    } catch (e) {
      logger.warn("Sprint atama hatası (ticket yine de oluştu)", {
        message: e instanceof Error ? e.message : String(e),
      });
    }

    return {
      ticketKey: created.key,
      ticketUrl,
      summary: draft.summary,
      priority: draft.priority,
      issueType: draft.issueType,
      labels: draft.labels,
      sprintAdded: sprintInfo.added,
      sprintName: sprintInfo.sprintName,
    };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("createBugTicket failed", { message });
      // "internal" iOS SDK'sında maskelenir (çıplak "INTERNAL"); Claude/Jira
      // hata mesajı istemcide görünsün diye "unavailable" kullanıyoruz.
      throw new HttpsError("unavailable", `Ticket oluşturulamadı: ${message}`);
    }
  }
);
