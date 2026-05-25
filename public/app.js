const API_ENDPOINT = "/api/createJiraTicket";
const PASSWORD_STORAGE_KEY = "jira_form_password";

const form = document.getElementById("ticketForm");
const textarea = document.getElementById("userInput");
const charCount = document.getElementById("charCount");
const submitBtn = document.getElementById("submitBtn");
const result = document.getElementById("result");

const passwordOverlay = document.getElementById("passwordOverlay");
const passwordForm = document.getElementById("passwordForm");
const passwordInput = document.getElementById("passwordInput");
const passwordError = document.getElementById("passwordError");

const MAX_LENGTH = 5000;

function getStoredPassword() {
  try {
    return localStorage.getItem(PASSWORD_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function setStoredPassword(value) {
  try {
    if (value) localStorage.setItem(PASSWORD_STORAGE_KEY, value);
    else localStorage.removeItem(PASSWORD_STORAGE_KEY);
  } catch {
    // localStorage erişilemez (incognito vb.) — sessizce devam
  }
}

function showPasswordOverlay() {
  passwordOverlay.classList.remove("hidden");
  passwordError.classList.add("hidden");
  passwordInput.value = "";
  setTimeout(() => passwordInput.focus(), 50);
}

function hidePasswordOverlay() {
  passwordOverlay.classList.add("hidden");
}

if (!getStoredPassword()) {
  showPasswordOverlay();
}

passwordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = passwordInput.value.trim();
  if (!value) return;
  setStoredPassword(value);
  hidePasswordOverlay();
});

function updateCharCount() {
  const len = textarea.value.length;
  charCount.textContent = `${len} / ${MAX_LENGTH}`;
  charCount.style.color = len > MAX_LENGTH * 0.9 ? "var(--error)" : "";
}

textarea.addEventListener("input", updateCharCount);
updateCharCount();

function setLoading(loading) {
  submitBtn.disabled = loading;
  submitBtn.classList.toggle("loading", loading);
  submitBtn.querySelector(".btn-label").textContent = loading
    ? "Oluşturuluyor..."
    : "Ticket Oluştur";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderSuccess(data) {
  result.classList.remove("hidden", "error");
  result.innerHTML = `
    <div class="result-heading">
      <span class="dot"></span>
      <span>Ticket Oluşturuldu</span>
    </div>
    <a href="${escapeHtml(data.ticketUrl)}" target="_blank" rel="noopener" class="ticket-link">
      ${escapeHtml(data.ticketKey)} →
    </a>
    <div class="ticket-summary">${escapeHtml(data.summary)}</div>
    <div class="meta-row">
      <span class="chip">${escapeHtml(data.issueType)}</span>
      <span class="chip chip-priority" data-priority="${escapeHtml(data.priority)}">
        ${escapeHtml(data.priority)}
      </span>
      ${
        data.sprintAdded && data.sprintName
          ? `<span class="chip chip-sprint">🏃 ${escapeHtml(data.sprintName)}</span>`
          : ""
      }
      ${(data.labels || [])
        .map((l) => `<span class="chip">#${escapeHtml(l)}</span>`)
        .join("")}
    </div>
    <div class="description-block">${escapeHtml(data.description)}</div>
  `;
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderError(message) {
  result.classList.remove("hidden");
  result.classList.add("error");
  result.innerHTML = `
    <div class="result-heading">
      <span class="dot"></span>
      <span>Hata</span>
    </div>
    <p class="error-message">${escapeHtml(message)}</p>
  `;
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const userInput = textarea.value.trim();
  if (userInput.length < 5) {
    renderError("Lütfen sorununuzu en az birkaç kelimeyle anlatın.");
    return;
  }

  const password = getStoredPassword();
  if (!password) {
    showPasswordOverlay();
    return;
  }

  setLoading(true);
  result.classList.add("hidden");

  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Password": password,
      },
      body: JSON.stringify({ userInput }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      setStoredPassword("");
      passwordError.classList.remove("hidden");
      passwordError.textContent = "Şifre yanlış. Tekrar deneyin.";
      showPasswordOverlay();
      return;
    }

    if (!response.ok) {
      renderError(data.error || `Sunucu hatası (${response.status})`);
      return;
    }

    renderSuccess(data);
    textarea.value = "";
    updateCharCount();
  } catch (err) {
    renderError(
      "Bağlantı hatası: " + (err instanceof Error ? err.message : String(err))
    );
  } finally {
    setLoading(false);
  }
});
