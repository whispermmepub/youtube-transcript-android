import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

import { buildDocxBase64 } from "@/lib/docx-core";
import type { TranscriptDocument } from "@/shared/transcript";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function safeFileName(title: string): string {
  return title.replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff\u3040-\u30ff\u3400-\u9fff\s_-]/giu, "").trim().slice(0, 70) || "youtube-transcript";
}

export { buildDocxBase64 };

export async function exportDocx(document: TranscriptDocument, includeTimestamps = false): Promise<string> {
  const base64 = await buildDocxBase64(document, includeTimestamps);
  if (Platform.OS === "web") {
    const bytes = Uint8Array.from(globalThis.atob(base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: DOCX_MIME });
    const url = globalThis.URL.createObjectURL(blob);
    const anchor = globalThis.document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(document.title)}.docx`;
    anchor.click();
    globalThis.URL.revokeObjectURL(url);
    return url;
  }

  const fileUri = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory}${safeFileName(document.title)}-${Date.now()}.docx`;
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri, {
      mimeType: DOCX_MIME,
      dialogTitle: "Export transcript",
      UTI: DOCX_MIME,
    });
  }
  return fileUri;
}
