import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";
import { File } from "expo-file-system";

import type { TranscriptProvider, TranscriptSegment } from "@/shared/transcript";

export type CloudProvider = "gemini" | "groq" | "openai";
export type ProviderKeys = Record<CloudProvider, string>;

const KEY_NAMES: Record<CloudProvider, string> = {
  gemini: "youtube-transcript-studio.gemini-api-key.v2",
  groq: "youtube-transcript-studio.groq-api-key.v1",
  openai: "youtube-transcript-studio.openai-api-key.v1",
};

const GEMINI_MODEL = "gemini-3.7-flash";
const GROQ_ACCURACY_MODEL = "whisper-large-v3";
const OPENAI_MODEL = "gpt-4o-transcribe";

export type CloudTranscriptionResult = {
  provider: TranscriptProvider;
  language: string;
  segments: TranscriptSegment[];
  text: string;
};

function normalizeLanguage(language?: string): string | undefined {
  const value = language?.trim().toLowerCase();
  if (!value || value === "auto" || value === "unknown") return undefined;
  const aliases: Record<string, string> = {
    burmese: "my",
    myanmar: "my",
    english: "en",
    thai: "th",
  };
  return aliases[value] ?? value.split(/[-_]/u)[0];
}

function cleanText(value: string): string {
  return value
    .replace(/^```(?:json)?/iu, "")
    .replace(/```$/u, "")
    .replace(/\u0000/gu, "")
    .trim();
}

function toSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({
      text: String(item?.text ?? "").replace(/\s+/gu, " ").trim(),
      start: Math.max(0, Number(item?.start ?? item?.start_time ?? 0) || 0),
      duration: Math.max(
        0,
        Number(item?.duration ?? 0) ||
          Math.max(0, (Number(item?.end ?? item?.end_time ?? 0) || 0) - (Number(item?.start ?? item?.start_time ?? 0) || 0)),
      ),
    }))
    .filter((item) => item.text);
}

export async function getProviderKey(provider: CloudProvider): Promise<string> {
  return (await SecureStore.getItemAsync(KEY_NAMES[provider]))?.trim() ?? "";
}

export async function saveProviderKey(provider: CloudProvider, value: string): Promise<void> {
  const clean = value.trim();
  if (!clean) {
    await SecureStore.deleteItemAsync(KEY_NAMES[provider]);
    return;
  }
  await SecureStore.setItemAsync(KEY_NAMES[provider], clean, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function getConfiguredProviders(): Promise<CloudProvider[]> {
  const values = await Promise.all((Object.keys(KEY_NAMES) as CloudProvider[]).map(async (provider) => [provider, await getProviderKey(provider)] as const));
  return values.filter(([, key]) => Boolean(key)).map(([provider]) => provider);
}

function parseGeminiTranscript(text: string): { language: string; segments: TranscriptSegment[] } {
  const clean = cleanText(text);
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini returned an invalid transcript response.");
  const parsed = JSON.parse(clean.slice(start, end + 1)) as any;
  const segments = toSegments(parsed?.segments);
  if (!segments.length) {
    const plain = String(parsed?.text ?? "").trim();
    if (!plain) throw new Error("Gemini returned no transcript text.");
    return { language: String(parsed?.language ?? "unknown"), segments: [{ text: plain, start: 0, duration: 0 }] };
  }
  return { language: String(parsed?.language ?? "unknown"), segments };
}

function transcriptionPrompt(language?: string): string {
  const hint = language?.trim() ? `The likely language is ${language.trim()}.` : "Detect the spoken language.";
  return [
    "Transcribe the spoken audio faithfully and completely.",
    hint,
    "Do not summarize, translate, censor, rewrite, or invent speech.",
    "Preserve Myanmar/Burmese Unicode and names exactly as heard.",
    "Use natural timestamped segments.",
    'Return ONLY valid JSON: {"language":"ISO code","segments":[{"start":0,"duration":0,"text":"spoken words"}]}.',
    "start and duration are seconds as numbers.",
  ].join(" ");
}

async function uploadGeminiFile(file: File, apiKey: string): Promise<{ uri: string; name?: string; mimeType: string }> {
  const mimeType = file.type || "application/octet-stream";
  const startResponse = await expoFetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: file.name || "transcript-media" } }),
  });
  if (!startResponse.ok) {
    const detail = await startResponse.text().catch(() => "");
    throw new Error(`Gemini upload start failed (${startResponse.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return an upload URL.");

  const uploadResponse = await expoFetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(file.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: file,
  });
  const payload = await uploadResponse.json().catch(() => null) as any;
  if (!uploadResponse.ok) throw new Error(payload?.error?.message || `Gemini upload failed (${uploadResponse.status}).`);
  const uri = payload?.file?.uri;
  if (!uri) throw new Error("Gemini upload returned no file URI.");
  return { uri, name: payload?.file?.name, mimeType: payload?.file?.mimeType || mimeType };
}

async function deleteGeminiFile(name: string | undefined, apiKey: string): Promise<void> {
  if (!name) return;
  try {
    await expoFetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey },
    });
  } catch {
    // Uploaded files expire automatically. Cleanup is best-effort.
  }
}

export async function transcribeWithGeminiFile(file: File, language?: string): Promise<CloudTranscriptionResult> {
  const apiKey = await getProviderKey("gemini");
  if (!apiKey) throw new Error("Gemini API key is not configured.");
  const uploaded = await uploadGeminiFile(file, apiKey);
  try {
    const response = await expoFetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: transcriptionPrompt(language) }, { file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    const payload = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed (${response.status}).`);
    const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((part: any) => part?.text ?? "").join("\n").trim();
    if (!text) throw new Error("Gemini returned no transcript.");
    const parsed = parseGeminiTranscript(text);
    return { provider: "gemini", language: parsed.language, segments: parsed.segments, text: parsed.segments.map((item) => item.text).join("\n") };
  } finally {
    await deleteGeminiFile(uploaded.name, apiKey);
  }
}

function appendLanguage(form: FormData, language?: string): void {
  const normalized = normalizeLanguage(language);
  if (normalized) form.append("language", normalized);
}

export async function transcribeWithGroq(file: File, language?: string): Promise<CloudTranscriptionResult> {
  const apiKey = await getProviderKey("groq");
  if (!apiKey) throw new Error("Groq API key is not configured.");
  const form = new FormData();
  form.append("file", file as unknown as Blob, file.name || "audio.wav");
  form.append("model", GROQ_ACCURACY_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  appendLanguage(form, language);
  const response = await expoFetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.error?.message || `Groq request failed (${response.status}).`);
  const segments = toSegments(payload?.segments);
  const text = String(payload?.text ?? "").trim();
  const finalSegments = segments.length ? segments : text ? [{ text, start: 0, duration: 0 }] : [];
  if (!finalSegments.length) throw new Error("Groq returned no transcript text.");
  return {
    provider: "groq",
    language: String(payload?.language ?? normalizeLanguage(language) ?? "unknown"),
    segments: finalSegments,
    text: finalSegments.map((item) => item.text).join("\n"),
  };
}

export async function transcribeWithOpenAI(file: File, language?: string): Promise<CloudTranscriptionResult> {
  const apiKey = await getProviderKey("openai");
  if (!apiKey) throw new Error("OpenAI API key is not configured.");
  const form = new FormData();
  form.append("file", file as unknown as Blob, file.name || "audio.wav");
  form.append("model", OPENAI_MODEL);
  form.append("response_format", "json");
  appendLanguage(form, language);
  const response = await expoFetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed (${response.status}).`);
  const text = String(payload?.text ?? "").trim();
  if (!text) throw new Error("OpenAI returned no transcript text.");
  return {
    provider: "openai",
    language: String(payload?.language ?? normalizeLanguage(language) ?? "unknown"),
    segments: [{ text, start: 0, duration: 0 }],
    text,
  };
}

export async function transcribeCloudFile(
  file: File,
  provider: CloudProvider,
  language?: string,
): Promise<CloudTranscriptionResult> {
  if (provider === "groq") return transcribeWithGroq(file, language);
  if (provider === "openai") return transcribeWithOpenAI(file, language);
  return transcribeWithGeminiFile(file, language);
}

export async function transcribeCloudFileAuto(
  file: File,
  language?: string,
  preferred: CloudProvider[] = ["groq", "openai", "gemini"],
): Promise<CloudTranscriptionResult> {
  const configured = new Set(await getConfiguredProviders());
  const attempts: string[] = [];
  for (const provider of preferred) {
    if (!configured.has(provider)) continue;
    try {
      return await transcribeCloudFile(file, provider, language);
    } catch (error) {
      attempts.push(`${provider}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  if (!configured.size) throw new Error("No cloud AI provider key is configured.");
  throw new Error(`All configured cloud providers failed. ${attempts.join(" | ")}`);
}
