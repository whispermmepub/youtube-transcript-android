import { FFmpegKit, FFprobeKit, ReturnCode } from "@wokcito/ffmpeg-kit-react-native";
import { Directory, File, Paths } from "expo-file-system";
import { initWhisper } from "whisper.rn";

import { getConfiguredProviders, transcribeCloudFileAuto, type CloudProvider } from "@/lib/ai-providers";
import { parseSubtitle } from "@/lib/subtitle-parser";
import type { ImportedTranscript, TranscriptSegment } from "@/shared/transcript";

export type FileImportMode = "auto" | "subtitle-only" | "no-cloud" | "offline-only" | "best-quality";

export type LocalMediaStage =
  | "reading"
  | "embedded-subtitles"
  | "preparing-audio"
  | "downloading-model"
  | "offline-transcription"
  | "cloud-fallback";

export type FileImportOptions = {
  mode?: FileImportMode;
  language?: string;
  cloudOrder?: CloudProvider[];
  onStage?: (stage: LocalMediaStage, detail?: string) => void;
};

const MODEL_FILE = "ggml-base-q5_1.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}?download=true`;
const MIN_MODEL_BYTES = 50_000_000;
const SUBTITLE_EXTENSIONS = new Set(["srt", "vtt", "ass", "ssa", "txt"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mov", "m4v", "avi", "ts", "m2ts"]);

function extensionOf(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

function safeName(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return clean.slice(-96) || `media-${Date.now()}`;
}

function ffmpegPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//u, ""));
}

function quote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

async function cachedCopy(input: File): Promise<File> {
  if (input.uri.startsWith("file://")) return input;
  const target = new File(Paths.cache, `transcript-${Date.now()}-${safeName(input.name || "media")}`);
  if (target.exists) target.delete();
  input.copy(target);
  return target;
}

async function runFfmpeg(command: string): Promise<string> {
  const session = await FFmpegKit.execute(command);
  const returnCode = await session.getReturnCode();
  if (!ReturnCode.isSuccess(returnCode)) {
    const output = await session.getOutput().catch(() => "");
    const stack = await session.getFailStackTrace().catch(() => "");
    throw new Error((output || stack || "FFmpeg operation failed.").slice(-800));
  }
  return await session.getOutput().catch(() => "");
}

async function probeStreams(file: File): Promise<any[]> {
  const session = await FFprobeKit.execute(`-v error -show_streams -of json ${quote(ffmpegPath(file.uri))}`);
  const code = await session.getReturnCode();
  if (!ReturnCode.isSuccess(code)) return [];
  const output = await session.getOutput().catch(() => "");
  try {
    const parsed = JSON.parse(output) as { streams?: any[] };
    return Array.isArray(parsed.streams) ? parsed.streams : [];
  } catch {
    return [];
  }
}

async function tryEmbeddedSubtitles(file: File, language?: string): Promise<{ language: string; segments: TranscriptSegment[]; text: string } | null> {
  if (!VIDEO_EXTENSIONS.has(extensionOf(file.name))) return null;
  const streams = (await probeStreams(file)).filter((stream) => stream?.codec_type === "subtitle");
  if (!streams.length) return null;
  const requested = language?.trim().toLowerCase();
  streams.sort((a, b) => {
    if (!requested) return 0;
    const aLang = String(a?.tags?.language ?? "").toLowerCase();
    const bLang = String(b?.tags?.language ?? "").toLowerCase();
    return Number(bLang.startsWith(requested)) - Number(aLang.startsWith(requested));
  });

  for (const stream of streams.slice(0, 6)) {
    const globalIndex = Number(stream?.index);
    if (!Number.isFinite(globalIndex)) continue;
    const out = new File(Paths.cache, `embedded-${Date.now()}-${globalIndex}.srt`);
    if (out.exists) out.delete();
    try {
      await runFfmpeg(`-y -i ${quote(ffmpegPath(file.uri))} -map 0:${globalIndex} -c:s srt ${quote(ffmpegPath(out.uri))}`);
      if (!out.exists || out.size <= 0) continue;
      const parsed = parseSubtitle(await out.text(), out.name);
      if (!parsed.segments.length) continue;
      return {
        language: String(stream?.tags?.language ?? language ?? "unknown"),
        segments: parsed.segments,
        text: parsed.text,
      };
    } catch {
      // Image/bitmap subtitle streams cannot become plain transcript text without OCR.
    } finally {
      if (out.exists) out.delete();
    }
  }
  return null;
}

async function convertToWhisperWav(file: File): Promise<File> {
  const output = new File(Paths.cache, `whisper-${Date.now()}.wav`);
  if (output.exists) output.delete();
  await runFfmpeg(`-y -i ${quote(ffmpegPath(file.uri))} -vn -map 0:a:0? -ac 1 -ar 16000 -c:a pcm_s16le ${quote(ffmpegPath(output.uri))}`);
  if (!output.exists || output.size < 1024) throw new Error("Could not extract a usable audio track from this file.");
  return output;
}

function modelDirectory(): Directory {
  const directory = new Directory(Paths.document, "transcript-models");
  if (!directory.exists) directory.create();
  return directory;
}

export function getOfflineModelFile(): File {
  return new File(modelDirectory(), MODEL_FILE);
}

export function isOfflineModelReady(): boolean {
  try {
    const model = getOfflineModelFile();
    return model.exists && model.size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

export async function removeOfflineModel(): Promise<void> {
  const model = getOfflineModelFile();
  if (model.exists) model.delete();
}

export async function ensureOfflineModel(onStage?: FileImportOptions["onStage"]): Promise<File> {
  const model = getOfflineModelFile();
  if (model.exists && model.size >= MIN_MODEL_BYTES) return model;
  if (model.exists) model.delete();
  onStage?.("downloading-model", "Downloading the ~60 MB multilingual offline model once…");
  try {
    const downloaded = await File.downloadFileAsync(MODEL_URL, model);
    if (!downloaded.exists || downloaded.size < MIN_MODEL_BYTES) {
      if (downloaded.exists) downloaded.delete();
      throw new Error("Offline model download was incomplete.");
    }
    return downloaded;
  } catch (error) {
    if (model.exists && model.size < MIN_MODEL_BYTES) model.delete();
    throw error;
  }
}

function whisperSegments(raw: any[]): TranscriptSegment[] {
  return (Array.isArray(raw) ? raw : [])
    .map((segment: any) => {
      const t0 = Number(segment?.t0 ?? 0) || 0;
      const t1 = Number(segment?.t1 ?? t0) || t0;
      return {
        text: String(segment?.text ?? "").replace(/\s+/gu, " ").trim(),
        start: Math.max(0, t0 * 0.01),
        duration: Math.max(0, (t1 - t0) * 0.01),
      };
    })
    .filter((segment) => segment.text && !/^\[(?:BLANK_AUDIO|SOUND|MUSIC)\]$/iu.test(segment.text));
}

async function transcribeOffline(
  wav: File,
  language?: string,
  onStage?: FileImportOptions["onStage"],
): Promise<{ language: string; segments: TranscriptSegment[]; text: string }> {
  const model = await ensureOfflineModel(onStage);
  onStage?.("offline-transcription", "Running Whisper locally on this phone — media stays on device…");
  const context = await initWhisper({ filePath: model.uri });
  try {
    const languageHint = language?.trim().toLowerCase();
    const normalized = !languageHint || languageHint === "auto" || languageHint === "unknown"
      ? undefined
      : languageHint === "burmese" || languageHint === "myanmar"
        ? "my"
        : languageHint.split(/[-_]/u)[0];
    const { promise } = context.transcribe(wav.uri, {
      language: normalized,
      maxThreads: 4,
      temperature: 0,
      translate: false,
      tokenTimestamps: false,
    });
    const result = await promise;
    const segments = whisperSegments((result as any)?.segments);
    const fallback = String((result as any)?.result ?? "").replace(/\s+/gu, " ").trim();
    const finalSegments = segments.length ? segments : fallback ? [{ text: fallback, start: 0, duration: 0 }] : [];
    if (!finalSegments.length) throw new Error("Offline Whisper could not detect spoken words in this file.");
    return {
      language: String((result as any)?.language ?? normalized ?? "unknown"),
      segments: finalSegments,
      text: finalSegments.map((item) => item.text).join("\n"),
    };
  } finally {
    await context.release();
  }
}

function importedFromFile(
  file: File,
  source: ImportedTranscript["source"],
  provider: ImportedTranscript["provider"],
  language: string,
  segments: TranscriptSegment[],
  text: string,
): ImportedTranscript {
  const now = Date.now();
  return {
    videoId: `file-${now}`,
    title: file.name.replace(/\.[^.]+$/u, "") || "Imported media",
    url: file.uri,
    language,
    source,
    provider,
    fileName: file.name,
    segments,
    originalText: text,
  };
}

export async function pickTranscriptFile(): Promise<File> {
  const picked = await File.pickFileAsync();
  const file = Array.isArray(picked) ? picked[0] : picked;
  if (!file) throw new Error("No file selected.");
  return file;
}

async function localSpeechTranscript(file: File, options: FileImportOptions): Promise<ImportedTranscript> {
  let wav: File | null = null;
  try {
    options.onStage?.("preparing-audio", "Preparing a 16 kHz speech track locally…");
    wav = await convertToWhisperWav(file);
    const local = await transcribeOffline(wav, options.language, options.onStage);
    return importedFromFile(file, "local", "whisper-local", local.language, local.segments, local.text);
  } finally {
    if (wav?.exists) wav.delete();
  }
}

async function cloudTranscript(file: File, options: FileImportOptions): Promise<ImportedTranscript> {
  options.onStage?.("cloud-fallback", "Trying an enabled cloud speech provider…");
  const cloud = await transcribeCloudFileAuto(file, options.language, options.cloudOrder);
  return importedFromFile(file, "ai", cloud.provider, cloud.language, cloud.segments, cloud.text);
}

export async function importMediaFile(input: File, options: FileImportOptions = {}): Promise<ImportedTranscript> {
  const mode = options.mode ?? "auto";
  options.onStage?.("reading", `Reading ${input.name}…`);
  const ext = extensionOf(input.name);

  if (SUBTITLE_EXTENSIONS.has(ext)) {
    const parsed = parseSubtitle(await input.text(), input.name);
    if (!parsed.segments.length) throw new Error("This subtitle/text file does not contain usable transcript text.");
    return importedFromFile(input, "subtitle", "subtitle-file", options.language ?? "unknown", parsed.segments, parsed.text);
  }

  const file = await cachedCopy(input);
  options.onStage?.("embedded-subtitles", "Checking embedded subtitles first — no AI…");
  const embedded = await tryEmbeddedSubtitles(file, options.language);
  if (embedded) return importedFromFile(input, "embedded", "embedded-subtitle", embedded.language, embedded.segments, embedded.text);

  if (mode === "subtitle-only") {
    throw new Error("ဒီ file ထဲမှာ text subtitle track မတွေ့ပါ။ Subtitle Only mode က speech AI/model လုံးဝမသုံးပါ။");
  }

  const configured = await getConfiguredProviders();
  if (mode === "best-quality" && configured.length) {
    try {
      return await cloudTranscript(file, options);
    } catch {
      // Cloud failure must not make the file unusable. Fall back to local transcription.
      return localSpeechTranscript(file, options);
    }
  }

  try {
    return await localSpeechTranscript(file, options);
  } catch (localError) {
    if (mode === "no-cloud" || mode === "offline-only") throw localError;
    if (!configured.length) {
      throw new Error(`${localError instanceof Error ? localError.message : "Offline transcription failed."} Cloud fallback keys are not configured.`);
    }
    return cloudTranscript(file, options);
  }
}
