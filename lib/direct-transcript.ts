import * as SecureStore from "expo-secure-store";

import type { ImportedTranscript, TranscriptSegment } from "@/shared/transcript";
import { parseYouTubeLink } from "@/lib/youtube";

const GEMINI_KEY = "youtube-transcript-studio.gemini-api-key.v1";
const GEMINI_MODEL = "gemini-3.7-flash";

export type DirectImportResult = ImportedTranscript & {
  provider: "youtube" | "gemini";
};

export async function getGeminiApiKey(): Promise<string> {
  return (await SecureStore.getItemAsync(GEMINI_KEY))?.trim() ?? "";
}

export async function saveGeminiApiKey(value: string): Promise<void> {
  const clean = value.trim();
  if (!clean) {
    await SecureStore.deleteItemAsync(GEMINI_KEY);
    return;
  }
  await SecureStore.setItemAsync(GEMINI_KEY, clean, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

function cleanText(value: string): string {
  return value.replace(/\n+/gu, " ").replace(/\s+/gu, " ").trim();
}

function extractBalancedArray(source: string, marker: string): string | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

function chooseTrack(tracks: CaptionTrack[], language?: string): CaptionTrack | null {
  if (!tracks.length) return null;
  const requested = language?.trim().toLowerCase();
  if (requested) {
    const exact = tracks.find((track) => track.languageCode?.toLowerCase() === requested);
    if (exact) return exact;
    const prefix = tracks.find((track) => track.languageCode?.toLowerCase().startsWith(requested));
    if (prefix) return prefix;
  }
  return tracks.find((track) => track.kind !== "asr") ?? tracks[0];
}

async function fetchTitle(url: string, videoId: string): Promise<string> {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const data = await response.json() as { title?: string };
      if (data.title?.trim()) return data.title.trim();
    }
  } catch {
    // Stable fallback below.
  }
  return `YouTube ${videoId}`;
}

async function tryYouTubeCaptions(
  url: string,
  language?: string,
): Promise<{ language: string; source: "creator" | "automatic"; segments: TranscriptSegment[] } | null> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
    },
  });
  if (!response.ok) return null;
  const html = await response.text();
  const rawTracks = extractBalancedArray(html, '"captionTracks":');
  if (!rawTracks) return null;
  let tracks: CaptionTrack[] = [];
  try {
    tracks = JSON.parse(rawTracks) as CaptionTrack[];
  } catch {
    return null;
  }
  const track = chooseTrack(tracks, language);
  if (!track?.baseUrl) return null;

  const separator = track.baseUrl.includes("?") ? "&" : "?";
  const captionResponse = await fetch(`${track.baseUrl}${separator}fmt=json3`);
  if (!captionResponse.ok) return null;
  const data = await captionResponse.json() as any;
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments: TranscriptSegment[] = [];
  for (const event of events) {
    const text = cleanText(Array.isArray(event?.segs) ? event.segs.map((seg: any) => seg?.utf8 ?? "").join("") : "");
    if (!text) continue;
    const start = Math.max(0, Number(event?.tStartMs ?? 0) / 1000 || 0);
    const duration = Math.max(0, Number(event?.dDurationMs ?? 0) / 1000 || 0);
    segments.push({ text, start, duration });
  }
  if (!segments.length) return null;
  return {
    language: track.languageCode || language || "unknown",
    source: track.kind === "asr" ? "automatic" : "creator",
    segments,
  };
}

function parseGeminiJson(text: string): { language: string; segments: TranscriptSegment[] } {
  const clean = text.replace(/^```(?:json)?/iu, "").replace(/```$/u, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini returned an invalid transcript response.");
  const parsed = JSON.parse(clean.slice(start, end + 1)) as any;
  const segments = (Array.isArray(parsed?.segments) ? parsed.segments : [])
    .map((item: any) => ({
      text: cleanText(String(item?.text ?? "")),
      start: Math.max(0, Number(item?.start ?? 0) || 0),
      duration: Math.max(0, Number(item?.duration ?? 0) || 0),
    }))
    .filter((item: TranscriptSegment) => item.text);
  if (!segments.length) throw new Error("Gemini could not detect spoken transcript text in this video.");
  return { language: String(parsed?.language ?? "unknown"), segments };
}

async function tryGemini(
  url: string,
  apiKey: string,
  language?: string,
): Promise<{ language: string; segments: TranscriptSegment[] }> {
  const hint = language?.trim() ? ` Preferred language hint: ${language.trim()}.` : "";
  const prompt = [
    "Transcribe every spoken word in this YouTube video faithfully.",
    hint,
    "Do not summarize, translate, censor, rewrite, or invent missing speech.",
    "Preserve Myanmar/Burmese Unicode and the original spoken language exactly.",
    "Split the transcript into natural timestamped segments.",
    'Return ONLY valid JSON with this shape: {"language":"best ISO code","segments":[{"start":0,"duration":0,"text":"spoken words"}]}.',
    "start and duration must be seconds as numbers.",
  ].join(" ");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { file_data: { file_uri: url } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const message = payload?.error?.message;
    throw new Error(typeof message === "string" ? `Gemini: ${message}` : `Gemini request failed (${response.status}).`);
  }
  const text = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini returned no transcript text.");
  return parseGeminiJson(text);
}

export async function importDirectTranscript(
  inputUrl: string,
  language?: string,
  onStage?: (stage: "checking" | "captions" | "ai") => void,
): Promise<DirectImportResult> {
  onStage?.("checking");
  const parsed = parseYouTubeLink(inputUrl);
  if (parsed.kind !== "video" || !parsed.videoId) {
    throw new Error("Paste a YouTube video link. Playlist-only links are not supported yet.");
  }
  const url = `https://www.youtube.com/watch?v=${parsed.videoId}`;
  const titlePromise = fetchTitle(url, parsed.videoId);

  onStage?.("captions");
  try {
    const native = await tryYouTubeCaptions(url, language);
    if (native) {
      return {
        videoId: parsed.videoId,
        title: await titlePromise,
        url,
        language: native.language,
        source: native.source,
        provider: "youtube",
        segments: native.segments,
        originalText: native.segments.map((segment) => segment.text).join("\n"),
      };
    }
  } catch {
    // Native YouTube extraction is best-effort; AI remains a fallback only.
  }

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const error = new Error("ဒီ video မှာ usable caption မတွေ့ပါ။ AI fallback သုံးချင်ရင် Gemini API key ကို AI Fallback ထဲ တစ်ခါထည့်ပါ။");
    (error as Error & { code?: string }).code = "AI_KEY_REQUIRED";
    throw error;
  }

  onStage?.("ai");
  const ai = await tryGemini(url, apiKey, language);
  return {
    videoId: parsed.videoId,
    title: await titlePromise,
    url,
    language: ai.language,
    source: "ai",
    provider: "gemini",
    segments: ai.segments,
    originalText: ai.segments.map((segment) => segment.text).join("\n"),
  };
}
