import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { COOKIE_NAME } from "../shared/const";
import type {
  ImportedTranscript,
  ImportTranscriptsResult,
  PlaylistImport,
  TranscriptSegment,
} from "../shared/transcript";
import { parseYouTubeLink } from "../lib/youtube";

const PROVIDER_BASE_URL = "https://transcriptapi.com/api/v2";
const RETRYABLE_STATUS = new Set([408, 429, 503]);

const importInput = z.object({
  url: z.string().url().max(2_000),
  language: z.string().trim().max(80).optional(),
});

type ProviderSegment = { text?: unknown; start?: unknown; duration?: unknown };
type ProviderResponse = {
  video_id?: unknown;
  language?: unknown;
  transcript?: unknown;
  metadata?: { title?: unknown };
};
type PlaylistResponse = {
  results?: Array<{ videoId?: unknown; title?: unknown }>;
  playlist_info?: { title?: unknown };
  continuation_token?: unknown;
  has_more?: unknown;
};

function providerKey(): string {
  const key = process.env.TRANSCRIPT_API_KEY?.trim();
  if (!key) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Automatic transcript service is not configured yet.",
    });
  }
  return key;
}

async function providerFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = providerKey();
  const url = new URL(`${PROVIDER_BASE_URL}${path}`);
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
    });
    if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) break;
    const retryAfter = Number(response.headers.get("Retry-After") ?? "");
    const waitMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 4_000) : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (!response?.ok) {
    const status = response?.status ?? 502;
    let detail = "Transcript provider request failed.";
    try {
      const body = (await response?.json()) as { detail?: unknown; code?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // Keep the user-facing message stable when the provider does not return JSON.
    }
    const code = status === 401 ? "UNAUTHORIZED" : status === 402 ? "PRECONDITION_FAILED" : status === 404 ? "NOT_FOUND" : "BAD_GATEWAY";
    throw new TRPCError({ code, message: detail });
  }

  return (await response.json()) as T;
}

function toSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const segment = item as ProviderSegment;
    if (typeof segment.text !== "string") return [];
    return [{
      text: segment.text,
      start: typeof segment.start === "number" ? segment.start : 0,
      duration: typeof segment.duration === "number" ? segment.duration : 0,
    }];
  });
}

function importedFromProvider(response: ProviderResponse, fallbackUrl: string, fallbackTitle: string): ImportedTranscript {
  const segments = toSegments(response.transcript);
  const videoId = typeof response.video_id === "string" ? response.video_id : "unknown";
  const language = typeof response.language === "string" ? response.language : "unknown";
  const providerTitle = response.metadata && typeof response.metadata.title === "string" ? response.metadata.title : undefined;
  return {
    videoId,
    title: providerTitle ?? fallbackTitle,
    url: fallbackUrl,
    language,
    source: language.startsWith("asr-") ? "automatic" : "creator",
    segments,
    originalText: segments.map((segment) => segment.text.trim()).filter(Boolean).join("\n"),
  };
}

async function fetchVideoTranscript(url: string, preferredLanguage?: string): Promise<ImportedTranscript> {
  const parsed = parseYouTubeLink(url);
  if (!parsed.videoId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A video link is required for transcript retrieval." });
  }
  const response = await providerFetch<ProviderResponse>("/youtube/transcript", {
    video_url: parsed.videoId,
    format: "json",
    include_timestamp: "true",
    send_metadata: "true",
    ...(preferredLanguage ? { language: preferredLanguage } : {}),
  });
  return importedFromProvider(response, parsed.originalUrl, `YouTube video ${parsed.videoId}`);
}

async function fetchPlaylistItems(playlistId: string, originalUrl: string): Promise<{ title: string; items: Array<{ videoId: string; title: string; url: string }>; hasMore: boolean }> {
  const items: Array<{ videoId: string; title: string; url: string }> = [];
  let continuation: string | undefined;
  let title = "YouTube playlist";
  let pageCount = 0;

  do {
    const response = await providerFetch<PlaylistResponse>("/youtube/playlist/videos", continuation ? { continuation } : { playlist: playlistId });
    if (typeof response.playlist_info?.title === "string") title = response.playlist_info.title;
    for (const item of response.results ?? []) {
      if (typeof item.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/u.test(item.videoId)) continue;
      items.push({
        videoId: item.videoId,
        title: typeof item.title === "string" ? item.title : `YouTube video ${item.videoId}`,
        url: `https://www.youtube.com/watch?v=${item.videoId}`,
      });
    }
    continuation = typeof response.continuation_token === "string" && response.continuation_token ? response.continuation_token : undefined;
    pageCount += 1;
  } while (continuation && pageCount < 10);

  return { title, items, hasMore: Boolean(continuation) || pageCount >= 10 || originalUrl.length === 0 };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => run()));
  return results;
}

async function importLink(input: z.infer<typeof importInput>): Promise<ImportTranscriptsResult> {
  const parsed = parseYouTubeLink(input.url);
  if (parsed.kind === "video" && parsed.videoId) {
    const document = await fetchVideoTranscript(parsed.originalUrl, input.language);
    return { kind: "video", documents: [document] };
  }

  if (!parsed.playlistId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A playlist ID is required." });
  }
  const playlist = await fetchPlaylistItems(parsed.playlistId, parsed.originalUrl);
  const documents = await mapWithConcurrency(playlist.items, 4, async (item) => fetchVideoTranscript(item.url, input.language));
  const playlistImport: PlaylistImport = {
    playlistId: parsed.playlistId,
    title: playlist.title,
    hasMore: playlist.hasMore,
    items: documents,
  };
  return { kind: "playlist", documents, playlist: playlistImport };
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  transcripts: router({
    import: publicProcedure.input(importInput).mutation(({ input }) => importLink(input)),
  }),
});

export type AppRouter = typeof appRouter;
