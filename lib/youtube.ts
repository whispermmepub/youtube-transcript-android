import type { LinkKind } from "@/shared/transcript";

export type ParsedYouTubeLink = {
  kind: LinkKind;
  originalUrl: string;
  videoId?: string;
  playlistId?: string;
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,}$/u;

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./u, "");
  return host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtu.be";
}

function cleanId(value: string | null, pattern: RegExp): string | undefined {
  if (!value) return undefined;
  const decoded = decodeURIComponent(value).trim();
  return pattern.test(decoded) ? decoded : undefined;
}

export function parseYouTubeLink(input: string): ParsedYouTubeLink {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Paste a YouTube video or playlist link first.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That link is not a valid URL. Use a YouTube video or playlist link.");
  }

  if (!isYouTubeHost(url.hostname)) {
    throw new Error("Only youtube.com and youtu.be links are supported.");
  }

  const videoFromQuery = cleanId(url.searchParams.get("v"), VIDEO_ID);
  const playlistFromQuery = cleanId(url.searchParams.get("list"), PLAYLIST_ID);
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const videoFromPath =
    (pathSegments[0] === "shorts" || pathSegments[0] === "embed" || pathSegments[0] === "live")
      ? cleanId(pathSegments[1] ?? null, VIDEO_ID)
      : url.hostname.toLowerCase().replace(/^www\./u, "") === "youtu.be"
        ? cleanId(pathSegments[0] ?? null, VIDEO_ID)
        : undefined;

  const videoId = videoFromQuery ?? videoFromPath;
  if (videoId) {
    return {
      kind: "video",
      originalUrl: url.toString(),
      videoId,
      playlistId: playlistFromQuery,
    };
  }

  if (playlistFromQuery) {
    return { kind: "playlist", originalUrl: url.toString(), playlistId: playlistFromQuery };
  }

  throw new Error("No YouTube video or playlist ID was found in that link.");
}

export function formatSourceLanguage(language: string): string {
  if (!language) return "Source language";
  if (language.startsWith("asr-")) return `${language.slice(4).toUpperCase()} · Automatic captions`;
  return language.toUpperCase();
}
