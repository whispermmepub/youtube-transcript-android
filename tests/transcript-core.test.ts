import { describe, expect, it } from "vitest";

import { buildDocxBase64 } from "../lib/docx-core";
import { parsePastedTranscript, textToDocument } from "../lib/transcript-content";
import { parseYouTubeLink } from "../lib/youtube";
import type { TranscriptDocument } from "../shared/transcript";

const sampleDocument: TranscriptDocument = {
  id: "video-1",
  videoId: "dQw4w9WgXcQ",
  title: "A test transcript",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  language: "en",
  source: "automatic",
  segments: [{ text: "Hello & welcome", start: 0, duration: 2 }],
  originalText: "Hello & welcome",
  editedText: "Hello & welcome\nA second line.",
  createdAt: 1,
  updatedAt: 1,
};

describe("YouTube link parsing", () => {
  it("parses standard and short video links", () => {
    expect(parseYouTubeLink(sampleDocument.url)).toMatchObject({ kind: "video", videoId: "dQw4w9WgXcQ" });
    expect(parseYouTubeLink("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ kind: "video", videoId: "dQw4w9WgXcQ" });
  });

  it("parses playlist links", () => {
    expect(parseYouTubeLink("https://www.youtube.com/playlist?list=PL1234567890")).toMatchObject({ kind: "playlist", playlistId: "PL1234567890" });
  });

  it("rejects non-YouTube links", () => {
    expect(() => parseYouTubeLink("https://example.com/video")).toThrow(/Only youtube.com/);
  });
});

describe("No-key pasted transcript parsing", () => {
  it("cleans SRT/WebVTT cues while preserving timestamps and source text", () => {
    const source = `WEBVTT

00:00:01,000 --> 00:00:02,000
မင်္ဂလာပါ

[00:03] Welcome`;
    const parsed = parsePastedTranscript(source);
    expect(parsed.hasTimestamps).toBe(true);
    expect(parsed.cleanText).toBe(`မင်္ဂလာပါ
Welcome`);
    expect(parsed.segments[0]).toMatchObject({ text: "မင်္ဂလာပါ", start: 1 });
    expect(textToDocument(source, "Lecture notes", "https://youtu.be/dQw4w9WgXcQ", "my")).toMatchObject({
      title: "Lecture notes",
      language: "my",
      source: "pasted",
      sourceText: source,
      originalText: `မင်္ဂလာပါ
Welcome`,
    });
  });
});

describe("DOCX export", () => {
  it("creates a Word package containing escaped transcript text", async () => {
    const base64 = await buildDocxBase64(sampleDocument);
    expect(base64.length).toBeGreaterThan(100);
    const decoded = Buffer.from(base64, "base64").toString("base64");
    expect(decoded).toBe(base64);
  });
});
