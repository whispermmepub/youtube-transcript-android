import Constants from "expo-constants";

import type { ImportedTranscript } from "@/shared/transcript";

export type RemoteImportResult = ImportedTranscript & {
  provider: "youtube" | "gemini" | "groq";
};

function getApiUrl(): string {
  const configured = Constants.expoConfig?.extra?.transcriptApiUrl;
  if (typeof configured === "string" && configured.trim()) return configured.replace(/\/$/u, "");
  throw new Error("Transcript service is not configured in this build.");
}

export async function importYouTubeTranscript(url: string, language?: string): Promise<RemoteImportResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${getApiUrl()}/api/transcript/import`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ url, language: language?.trim() || undefined, allowAi: true }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok || !payload?.ok || !payload?.result) {
      throw new Error(typeof payload?.error === "string" ? payload.error : `Transcript service failed (${response.status}).`);
    }
    return payload.result as RemoteImportResult;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Transcript request timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
