# ClaudeBug Cloud Functions

Firebase Cloud Functions backend (TypeScript, Node 22) — bug analizi, Figma karşılaştırma (Claude `figmaCompare` + Gemini `figmaCompareGemini`), Jira ticket ve PR otomasyonu.

## Kurallar

- **Yorum dili:** Tüm kod yorumları **İngilizce** yazılır. Kullanıcıya dönen mesajlar (örn. `HttpsError` mesajları), log alanlarındaki Türkçe açıklamalar ve model prompt'ları (`SYSTEM_PROMPT` vb.) Türkçe kalabilir — kural yalnızca yorumlar içindir.
- **Hata kodları:** iOS Firebase SDK'sı `internal` kodlu `HttpsError` mesajlarını maskeler (istemci yalnızca "INTERNAL" görür). Mesajın istemcide görünmesi için `unavailable`, `failed-precondition` gibi kodlar kullan.
- **Build/Deploy:** `cd functions && npm run build` (tsc). Deploy: `npm run deploy` ya da tek fonksiyon için `npx firebase-tools deploy --only functions:<name>`.
- **Secrets:** `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `FIGMA_TOKEN` — Secret Manager'da; yeni fonksiyonlarda `defineSecret` ile bağla ve `onCall` config'inin `secrets` dizisine ekle.
