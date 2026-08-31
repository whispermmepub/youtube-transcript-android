import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ImportedTranscript, TranscriptDocument } from "@/shared/transcript";

const STORAGE_KEY = "youtube-transcript-studio.documents.v1";

export async function loadDocuments(): Promise<TranscriptDocument[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TranscriptDocument[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function persistDocuments(documents: TranscriptDocument[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
}

export async function upsertDocument(document: TranscriptDocument): Promise<TranscriptDocument[]> {
  const documents = await loadDocuments();
  const next = [document, ...documents.filter((item) => item.id !== document.id)].slice(0, 100);
  await persistDocuments(next);
  return next;
}

export async function deleteDocument(id: string): Promise<TranscriptDocument[]> {
  const next = (await loadDocuments()).filter((document) => document.id !== id);
  await persistDocuments(next);
  return next;
}

export function importedToDocument(imported: ImportedTranscript): TranscriptDocument {
  const now = Date.now();
  return {
    id: `${imported.videoId}-${now}`,
    videoId: imported.videoId,
    title: imported.title || "Untitled YouTube video",
    url: imported.url,
    language: imported.language,
    source: imported.source,
    segments: imported.segments,
    originalText: imported.originalText,
    editedText: imported.originalText,
    createdAt: now,
    updatedAt: now,
  };
}
