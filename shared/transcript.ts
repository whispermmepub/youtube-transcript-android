export type LinkKind = "video" | "playlist";

export type TranscriptSource = "creator" | "automatic";

export type TranscriptSegment = {
  text: string;
  start: number;
  duration: number;
};

export type TranscriptDocument = {
  id: string;
  videoId: string;
  title: string;
  url: string;
  language: string;
  source: TranscriptSource;
  segments: TranscriptSegment[];
  originalText: string;
  editedText: string;
  createdAt: number;
  updatedAt: number;
};

export type ImportedTranscript = {
  videoId: string;
  title: string;
  url: string;
  language: string;
  source: TranscriptSource;
  segments: TranscriptSegment[];
  originalText: string;
};

export type PlaylistImport = {
  playlistId: string;
  title: string;
  hasMore: boolean;
  items: ImportedTranscript[];
};

export type ImportTranscriptsResult = {
  kind: LinkKind;
  documents: ImportedTranscript[];
  playlist?: PlaylistImport;
};

export function segmentsToText(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function wordCount(text: string): number {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}
