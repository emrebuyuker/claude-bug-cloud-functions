import { defineSecret, defineString } from "firebase-functions/params";

// Shared param/secret definitions. Both the synchronous `askClaude` callable and
// the async job functions (`startBugAnalysis` / `processBugAnalysis`) must reference
// the SAME instances, so they live here rather than in any single function module.

export const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
export const githubToken = defineSecret("GITHUB_TOKEN");

export const githubOwner = defineString("GITHUB_OWNER", { default: "emrebuyuker" });
export const githubRepo = defineString("GITHUB_REPO", { default: "claude-bug-ios-client" });
export const iosSourceRoot = defineString("IOS_SOURCE_ROOT", { default: "ClaudeBugPoC" });
