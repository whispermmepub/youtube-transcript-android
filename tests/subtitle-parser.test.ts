import { describe, expect, it } from "vitest";

import { parseSubtitle, parseTimecode } from "../lib/subtitle-parser";

describe("local subtitle parser", () => {
  it("parses SRT timestamps and Myanmar Unicode", () => {
    const parsed = parseSubtitle(`1\n00:00:01,000 --> 00:00:03,500\nမင်္ဂလာပါ ခင်ဗျာ\n\n2\n00:00:04,000 --> 00:00:06,000\nWelcome &amp; hello`, "sample.srt");
    expect(parsed.format).toBe("srt");
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]).toMatchObject({ text: "မင်္ဂလာပါ ခင်ဗျာ", start: 1, duration: 2.5 });
    expect(parsed.segments[1].text).toBe("Welcome & hello");
  });

  it("parses WebVTT without cue numbers", () => {
    const parsed = parseSubtitle(`WEBVTT\n\n00:00.500 --> 00:02.000\nFirst line\n\n00:02.000 --> 00:03.250\nSecond line`, "sample.vtt");
    expect(parsed.format).toBe("vtt");
    expect(parsed.segments[0]).toMatchObject({ start: 0.5, duration: 1.5, text: "First line" });
  });

  it("parses ASS dialogue and strips style tags", () => {
    const parsed = parseSubtitle(`[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello{\\i0}\\NWorld`, "sample.ass");
    expect(parsed.format).toBe("ass");
    expect(parsed.segments[0]).toMatchObject({ start: 1, duration: 2, text: "Hello World" });
  });

  it("accepts bracketed timestamp text and plain lines", () => {
    const parsed = parseSubtitle(`[00:01] One\n[00:03] Two\nThree`, "notes.txt");
    expect(parsed.format).toBe("txt");
    expect(parsed.segments.map((item) => item.text)).toEqual(["One", "Two", "Three"]);
    expect(parsed.segments[0].start).toBe(1);
    expect(parsed.segments[1].start).toBe(3);
  });

  it("parses hour, minute, and fractional timecodes", () => {
    expect(parseTimecode("01:02:03.500")).toBe(3723.5);
    expect(parseTimecode("02:03,250")).toBe(123.25);
  });
});
