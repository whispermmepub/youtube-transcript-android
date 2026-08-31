import type { ImportedTranscript, TranscriptSegment } from "@/shared/transcript";
import { getProviderKey, saveProviderKey } from "@/lib/ai-providers";
import { parseYouTubeLink } from "@/lib/youtube";

const GEMINI_MODEL = "gemini-3.7-flash";

export type DirectImportResult = ImportedTranscript & {
  provider: "youtube" | "gemini";
};

export async function getGeminiApiKey(): Promise<string> {
  return getProviderKey("gemini");
}

export async function saveGeminiApiKey(value: string): Promise<void> {
  await saveProviderKey("gemini", value);
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
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
  isTranslatable?: boolean;
};

function normalizeLanguageHint(language?: string): string | undefined {
  const value = language?.trim().toLowerCase();
  if (!value) return undefined;
  const aliases: Record<string, string> = {
    burmese: "my",
    myanmar: "my",
    english: "en",
    thai: "th",
  };
  return aliases[value] ?? value.split(/[-_]/u)[0];
}

function chooseTrack(tracks: CaptionTrack[], language?: string): CaptionTrack | null {
  if (!tracks.length) return null;
  const requested = normalizeLanguageHint(language);
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

function parseJson3(data: any): TranscriptSegment[] {
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments: TranscriptSegment[] = [];
  for (const event of events) {
    const text = cleanText(Array.isArray(event?.segs) ? event.segs.map((seg: any) => seg?.utf8 ?? "").join("") : "");
    if (!text) continue;
    const start = Math.max(0, Number(event?.tStartMs ?? 0) / 1000 || 0);
    const duration = Math.max(0, Number(event?.dDurationMs ?? 0) / 1000 || 0);
    segments.push({ text, start, duration });
  }
  return segments;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/<[^>]*>/gu, "")
    .trim();
}

function parseXmlCaptions(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/giu;
  for (const match of xml.matchAll(regex)) {
    const attrs = match[1] ?? "";
    const start = Number(attrs.match(/\bstart="([^"]+)"/iu)?.[1] ?? 0) || 0;
    const duration = Number(attrs.match(/\bdur="([^"]+)"/iu)?.[1] ?? 0) || 0;
    const text = cleanText(decodeXml(match[2] ?? ""));
    if (text) segments.push({ text, start: Math.max(0, start), duration: Math.max(0, duration) });
  }
  return segments;
}

async function fetchCaptionSegments(baseUrl: string): Promise<TranscriptSegment[]> {
  const separator = baseUrl.includes("?") ? "&" : "?";
  try {
    const jsonResponse = await fetch(`${baseUrl}${separator}fmt=json3`);
    if (jsonResponse.ok) {
      const segments = parseJson3(await jsonResponse.json());
      if (segments.length) return segments;
    }
  } catch {
    // Try XML below.
  }
  try {
    const xmlResponse = await fetch(baseUrl);
    if (xmlResponse.ok) {
      const segments = parseXmlCaptions(await xmlResponse.text());
      if (segments.length) return segments;
    }
  } catch {
    // No usable direct caption representation.
  }
  return [];
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

  const preferred = chooseTrack(tracks, language);
  const ordered = preferred ? [preferred, ...tracks.filter((track) => track !== preferred)] : tracks;
  for (const track of ordered.slice(0, 8)) {
    if (!track?.baseUrl) continue;
    const segments = await fetchCaptionSegments(track.baseUrl);
    if (!segments.length) continue;
    return {
      language: track.languageCode || language || "unknown",
      source: track.kind === "asr" ? "automatic" : "creator",
      segments,
    };
  }
  return null;
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
    "Transcribe every spoken word in this public YouTube video faithfully.",
    hint,
    "Do not summarize, translate, censor, rewrite, or invent missing speech.",
    "Preserve Myanmar/Burmese Unicode and the original spoken language exactly.",
    "Split the transcript into natural timestamped segments.",
    'Return ONLY valid JSON with this shape: {"language":"best ISO code","segments":[{"start":0,"duration":0,"text":"spoken words"}]}.',
    "start and duration must be seconds as numbers.",
  ].join(" ");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }, { file_data: { file_uri: url } }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });

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
    // YouTube caption extraction is best-effort. Direct Gemini remains optional.
  }

  const apiKey = await getProviderKey("gemini");
  if (!apiKey) {
    const error = new Error("ဒီ video မှာ usable YouTube caption မတွေ့ပါ။ Link ကို AI နဲ့ဆက်လုပ်ချင်ရင် Gemini key ထည့်ပါ၊ ဒါမှမဟုတ် Audio/Video file ကိုရွေးပြီး Offline/Groq/OpenAI နဲ့လုပ်နိုင်ပါတယ်။");
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
