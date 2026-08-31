import type { TranscriptDocument, TranscriptSegment } from "@/shared/transcript";

export type ParsedPastedTranscript = {
  sourceText: string;
  cleanText: string;
  segments: TranscriptSegment[];
  hasTimestamps: boolean;
};

function parseTimestamp(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts.length === 1 && Number.isFinite(parts[0]) ? parts[0] : null;
}

function cleanCueText(value: string): string {
  return value.replace(/<[^>]+>/gu, "").replace(/&nbsp;/gu, " ").trim();
}

export function parsePastedTranscript(input: string): ParsedPastedTranscript {
  const sourceText = input.replace(/\r\n?/gu, "\n").trim();
  const lines = sourceText.split("\n");
  const segments: TranscriptSegment[] = [];
  let pendingTime: number | null = null;
  let hasTimestamps = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^WEBVTT(?:\s|$)/iu.test(line) || /^NOTE(?:\s|$)/iu.test(line)) continue;
    if (/^\d+$/u.test(line) && segments.length === 0) continue;

    const rangeMatch = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/u);
    if (rangeMatch) {
      pendingTime = parseTimestamp(rangeMatch[1]);
      hasTimestamps = pendingTime !== null;
      continue;
    }

    const bracketMatch = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]?\s+(.+)$/u);
    if (bracketMatch) {
      const start = parseTimestamp(bracketMatch[1]);
      const text = cleanCueText(bracketMatch[2]);
      if (text) segments.push({ text, start: start ?? 0, duration: 0 });
      hasTimestamps = hasTimestamps || start !== null;
      pendingTime = null;
      continue;
    }

    const text = cleanCueText(line);
    if (!text) continue;
    segments.push({ text, start: pendingTime ?? 0, duration: 0 });
    pendingTime = null;
  }

  const cleanText = segments.map((segment) => segment.text).join("\n");
  return { sourceText, cleanText, segments, hasTimestamps };
}

export function textToDocument(text: string, title = "Pasted transcript", sourceUrl = "", language = "unknown"): TranscriptDocument {
  const parsed = parsePastedTranscript(text);
  const now = Date.now();
  return {
    id: `local-${now}`,
    videoId: "local-paste",
    title: title.trim() || "Pasted transcript",
    url: sourceUrl.trim(),
    language: language.trim() || "unknown",
    source: "pasted",
    segments: parsed.segments,
    originalText: parsed.cleanText,
    sourceText: parsed.sourceText,
    editedText: parsed.cleanText,
    createdAt: now,
    updatedAt: now,
  };
}
