import type { Express, Request } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TranscriptSegment, TranscriptSource } from "../shared/transcript";

const execFileAsync = promisify(execFile);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_LIMIT = 60;
const AI_LIMIT = 8;

type CaptionTrack = {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
};

type ImportResult = {
  videoId: string;
  title: string;
  url: string;
  language: string;
  source: TranscriptSource;
  provider: "youtube" | "gemini" | "groq";
  segments: TranscriptSegment[];
  originalText: string;
};

type RateEntry = { startedAt: number; requests: number; aiRequests: number };
const rateEntries = new Map<string, RateEntry>();

function clientKey(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return first?.trim() || req.ip || "unknown";
}

function useRate(req: Request, ai = false): void {
  const key = clientKey(req);
  const now = Date.now();
  let entry = rateEntries.get(key);
  if (!entry || now - entry.startedAt >= REQUEST_WINDOW_MS) {
    entry = { startedAt: now, requests: 0, aiRequests: 0 };
    rateEntries.set(key, entry);
  }
  entry.requests += 1;
  if (ai) entry.aiRequests += 1;
  if (entry.requests > REQUEST_LIMIT) throw new Error("RATE_LIMIT");
  if (entry.aiRequests > AI_LIMIT) throw new Error("AI_RATE_LIMIT");
}

function parseVideoId(input: string): { videoId: string; normalizedUrl: string } {
  const value = input.trim();
  if (!value) throw new Error("Paste a YouTube link first.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    throw new Error("Only YouTube links are supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  let videoId = url.searchParams.get("v") ?? "";
  if (host === "youtu.be") videoId = parts[0] ?? "";
  if (["shorts", "live", "embed"].includes(parts[0] ?? "")) videoId = parts[1] ?? "";
  if (!VIDEO_ID.test(videoId)) throw new Error("No valid YouTube video ID was found.");
  return { videoId, normalizedUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.text();
}

async function fetchTitle(url: string, videoId: string): Promise<string> {
  try {
    const data = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (typeof data?.title === "string" && data.title.trim()) return data.title.trim();
  } catch {
    // Fall back to a stable local title below.
  }
  return `YouTube ${videoId}`;
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
    if (char === '"') { inString = true; continue; }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function trackLabel(track: CaptionTrack): string {
  return track.name?.simpleText ?? track.name?.runs?.map((item) => item.text ?? "").join("") ?? track.languageCode ?? "";
}

function chooseTrack(tracks: CaptionTrack[], preferredLanguage?: string): CaptionTrack | null {
  if (!tracks.length) return null;
  const requested = preferredLanguage?.trim().toLowerCase();
  if (requested) {
    const exact = tracks.find((track) => track.languageCode?.toLowerCase() === requested);
    if (exact) return exact;
    const prefix = tracks.find((track) => track.languageCode?.toLowerCase().startsWith(requested));
    if (prefix) return prefix;
  }
  return tracks.find((track) => track.kind !== "asr") ?? tracks[0];
}

function cleanSegmentText(value: string): string {
  return value.replace(/\n+/gu, " ").replace(/\s+/gu, " ").trim();
}

async function tryYouTubeCaptions(url: string, preferredLanguage?: string): Promise<Omit<ImportResult, "title" | "videoId" | "url"> | null> {
  const html = await fetchText(url, {
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36",
    },
  });
  const arrayText = extractBalancedArray(html, '"captionTracks":');
  if (!arrayText) return null;
  let tracks: CaptionTrack[];
  try {
    tracks = JSON.parse(arrayText) as CaptionTrack[];
  } catch {
    return null;
  }
  const track = chooseTrack(tracks, preferredLanguage);
  if (!track?.baseUrl) return null;
  const separator = track.baseUrl.includes("?") ? "&" : "?";
  const data = await fetchJson(`${track.baseUrl}${separator}fmt=json3`);
  const events = Array.isArray(data?.events) ? data.events : [];
  const segments: TranscriptSegment[] = [];
  for (const event of events) {
    const text = cleanSegmentText(Array.isArray(event?.segs) ? event.segs.map((seg: any) => seg?.utf8 ?? "").join("") : "");
    if (!text) continue;
    const start = Number(event?.tStartMs ?? 0) / 1000;
    const duration = Number(event?.dDurationMs ?? 0) / 1000;
    segments.push({ text, start: Number.isFinite(start) ? start : 0, duration: Number.isFinite(duration) ? duration : 0 });
  }
  if (!segments.length) return null;
  return {
    language: track.languageCode || trackLabel(track) || "unknown",
    source: track.kind === "asr" ? "automatic" : "creator",
    provider: "youtube",
    segments,
    originalText: segments.map((segment) => segment.text).join("\n"),
  };
}

function parseJsonObjectFromText(value: string): any {
  const cleaned = value.replace(/^```(?:json)?/iu, "").replace(/```$/u, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI_RESPONSE_INVALID");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeAiSegments(data: any): { language: string; segments: TranscriptSegment[] } {
  const rawSegments = Array.isArray(data?.segments) ? data.segments : [];
  const segments = rawSegments
    .map((segment: any) => {
      const text = cleanSegmentText(String(segment?.text ?? ""));
      const start = Number(segment?.start ?? 0);
      const duration = Number(segment?.duration ?? 0);
      return { text, start: Number.isFinite(start) ? Math.max(0, start) : 0, duration: Number.isFinite(duration) ? Math.max(0, duration) : 0 };
    })
    .filter((segment: TranscriptSegment) => segment.text);
  if (!segments.length) throw new Error("AI_RESPONSE_EMPTY");
  return { language: String(data?.language ?? "unknown"), segments };
}

function extractGeminiText(payload: any): string {
  const texts: string[] = [];
  const walk = (value: any): void => {
    if (!value) return;
    if (typeof value === "object" && typeof value.text === "string") texts.push(value.text);
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(payload?.steps ?? payload?.outputs ?? payload?.output ?? payload);
  return texts.join("\n").trim();
}

async function tryGemini(url: string, preferredLanguage?: string): Promise<Omit<ImportResult, "title" | "videoId" | "url"> | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const languageHint = preferredLanguage?.trim() ? ` Target language code hint: ${preferredLanguage.trim()}. Do not translate.` : " Do not translate.";
  const prompt = `Transcribe the spoken audio in this YouTube video faithfully.${languageHint} Return ONLY valid JSON with this exact shape: {"language":"ISO-639-1-or-best-code","segments":[{"start":0,"duration":0,"text":"spoken words"}]}. Use seconds as numbers. Preserve the original language, including Myanmar/Burmese. Do not summarize, censor, explain, or add markdown.`;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      model: "gemini-3.6-flash",
      input: [
        { type: "video", uri: url },
        { type: "text", text: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`GEMINI_${response.status}`);
  const payload = await response.json();
  const text = extractGeminiText(payload);
  const parsed = normalizeAiSegments(parseJsonObjectFromText(text));
  return {
    language: parsed.language,
    source: "ai",
    provider: "gemini",
    segments: parsed.segments,
    originalText: parsed.segments.map((segment) => segment.text).join("\n"),
  };
}

async function getAudioUrl(url: string): Promise<string> {
  const { stdout } = await execFileAsync("yt-dlp", ["--no-playlist", "-f", "bestaudio/best", "--get-url", url], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const audioUrl = stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!audioUrl) throw new Error("YTDLP_NO_AUDIO");
  return audioUrl;
}

async function tryGroq(url: string, preferredLanguage?: string): Promise<Omit<ImportResult, "title" | "videoId" | "url"> | null> {
  const keys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3, process.env.GROQ_API_KEY_4]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));
  if (!keys.length) return null;
  const audioUrl = await getAudioUrl(url);
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      const form = new FormData();
      form.append("url", audioUrl);
      form.append("model", "whisper-large-v3");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      if (preferredLanguage?.trim()) form.append("language", preferredLanguage.trim().slice(0, 8));
      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
      if (!response.ok) throw new Error(`GROQ_${response.status}`);
      const payload = await response.json();
      const rawSegments = Array.isArray(payload?.segments) ? payload.segments : [];
      const segments = rawSegments
        .map((segment: any) => ({
          text: cleanSegmentText(String(segment?.text ?? "")),
          start: Math.max(0, Number(segment?.start ?? 0) || 0),
          duration: Math.max(0, (Number(segment?.end ?? 0) || 0) - (Number(segment?.start ?? 0) || 0)),
        }))
        .filter((segment: TranscriptSegment) => segment.text);
      if (!segments.length && typeof payload?.text === "string" && payload.text.trim()) {
        segments.push({ text: cleanSegmentText(payload.text), start: 0, duration: 0 });
      }
      if (!segments.length) throw new Error("GROQ_EMPTY");
      return {
        language: String(payload?.language ?? preferredLanguage ?? "unknown"),
        source: "ai",
        provider: "groq",
        segments,
        originalText: segments.map((segment) => segment.text).join("\n"),
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function importTranscript(urlInput: string, preferredLanguage: string | undefined, allowAi: boolean, req: Request): Promise<ImportResult> {
  useRate(req, false);
  const { videoId, normalizedUrl } = parseVideoId(urlInput);
  const titlePromise = fetchTitle(normalizedUrl, videoId);

  try {
    const captions = await tryYouTubeCaptions(normalizedUrl, preferredLanguage);
    if (captions) return { videoId, title: await titlePromise, url: normalizedUrl, ...captions };
  } catch {
    // AI fallback below is intentionally only reached when native captions fail.
  }

  if (!allowAi) {
    const error = new Error("No usable YouTube captions were found. AI fallback is available.");
    (error as any).code = "AI_AVAILABLE";
    throw error;
  }

  useRate(req, true);
  const errors: string[] = [];
  try {
    const gemini = await tryGemini(normalizedUrl, preferredLanguage);
    if (gemini) return { videoId, title: await titlePromise, url: normalizedUrl, ...gemini };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Gemini failed");
  }
  try {
    const groq = await tryGroq(normalizedUrl, preferredLanguage);
    if (groq) return { videoId, title: await titlePromise, url: normalizedUrl, ...groq };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Groq failed");
  }

  throw new Error(errors.length ? `Transcript unavailable (${errors.join(", ")})` : "Transcript unavailable and no AI provider is configured.");
}

export function registerTranscriptRoutes(app: Express): void {
  app.post("/api/transcript/import", async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      const language = typeof req.body?.language === "string" ? req.body.language : undefined;
      const allowAi = req.body?.allowAi !== false;
      const result = await importTranscript(url, language, allowAi, req);
      res.json({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcript import failed.";
      const code = (error as any)?.code;
      const status = message === "RATE_LIMIT" || message === "AI_RATE_LIMIT" ? 429 : 400;
      res.status(status).json({ ok: false, error: message, code });
    }
  });
}
