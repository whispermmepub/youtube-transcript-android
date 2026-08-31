import type { TranscriptSegment } from "@/shared/transcript";

export type ParsedSubtitle = {
  segments: TranscriptSegment[];
  text: string;
  format: "srt" | "vtt" | "ass" | "txt";
};

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function cleanText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/gu, "")
    .replace(/\{\\[^}]+\}/gu, "")
    .replace(/\\N/gu, "\n")
    .replace(/\\n/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function parseTimecode(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (!parts.length || parts.length > 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((item) => !Number.isFinite(item))) return null;
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0];
}

function finalize(segments: TranscriptSegment[], format: ParsedSubtitle["format"]): ParsedSubtitle {
  const normalized = segments
    .filter((segment) => segment.text.trim())
    .map((segment) => ({
      ...segment,
      start: Math.max(0, Number.isFinite(segment.start) ? segment.start : 0),
      duration: Math.max(0, Number.isFinite(segment.duration) ? segment.duration : 0),
      text: cleanText(segment.text),
    }))
    .filter((segment) => segment.text);

  for (let index = 0; index < normalized.length - 1; index += 1) {
    if (normalized[index].duration <= 0) {
      normalized[index].duration = Math.max(0, normalized[index + 1].start - normalized[index].start);
    }
  }

  return {
    segments: normalized,
    text: normalized.map((segment) => segment.text).join("\n"),
    format,
  };
}

function parseSrtOrVtt(input: string, format: "srt" | "vtt"): ParsedSubtitle {
  const blocks = input
    .replace(/\r\n?/gu, "\n")
    .replace(/^\uFEFF/u, "")
    .split(/\n{2,}/u);
  const segments: TranscriptSegment[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT\b/iu.test(lines[0]) || /^NOTE\b/iu.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/([^\s]+)\s*-->\s*([^\s]+)/u);
    if (!timing) continue;
    const start = parseTimecode(timing[1]);
    const end = parseTimecode(timing[2]);
    if (start === null) continue;
    const text = cleanText(lines.slice(timingIndex + 1).join("\n"));
    if (!text) continue;
    segments.push({
      text,
      start,
      duration: end !== null ? Math.max(0, end - start) : 0,
    });
  }

  return finalize(segments, format);
}

function parseAss(input: string): ParsedSubtitle {
  const segments: TranscriptSegment[] = [];
  const lines = input.replace(/\r\n?/gu, "\n").split("\n");
  let formatFields: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^Format:/iu.test(line)) {
      formatFields = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((item) => item.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/iu.test(line)) continue;
    const body = line.slice(line.indexOf(":") + 1).trim();
    const fields = formatFields ?? ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    const textIndex = Math.max(0, fields.indexOf("text"));
    const pieces = body.split(",");
    if (pieces.length <= textIndex) continue;
    const valueAt = (name: string) => {
      const index = fields.indexOf(name);
      return index >= 0 ? pieces[index] : "";
    };
    const start = parseTimecode(valueAt("start"));
    const end = parseTimecode(valueAt("end"));
    if (start === null) continue;
    const text = cleanText(pieces.slice(textIndex).join(","));
    if (!text) continue;
    segments.push({ text, start, duration: end !== null ? Math.max(0, end - start) : 0 });
  }

  return finalize(segments, "ass");
}

function parsePlainText(input: string): ParsedSubtitle {
  const normalized = input.replace(/\r\n?/gu, "\n").replace(/^\uFEFF/u, "").trim();
  const segments: TranscriptSegment[] = [];
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]?\s+(.+)$/u);
    if (timed) {
      const start = parseTimecode(timed[1]) ?? 0;
      const text = cleanText(timed[2]);
      if (text) segments.push({ text, start, duration: 0 });
      continue;
    }
    const text = cleanText(line);
    if (text) segments.push({ text, start: segments.length, duration: 0 });
  }
  return finalize(segments, "txt");
}

export function parseSubtitle(input: string, fileName = "transcript.txt"): ParsedSubtitle {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  const normalized = input.trimStart();
  if (extension === "ass" || extension === "ssa" || /^\[Script Info\]/iu.test(normalized)) return parseAss(input);
  if (extension === "vtt" || /^WEBVTT\b/iu.test(normalized)) return parseSrtOrVtt(input, "vtt");
  if (extension === "srt" || /\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}\s*-->\s*/u.test(input)) return parseSrtOrVtt(input, "srt");
  return parsePlainText(input);
}
