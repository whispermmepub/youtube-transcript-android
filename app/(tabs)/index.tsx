import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { exportDocx } from "@/lib/docx-export";
import { formatSourceLanguage, parseYouTubeLink } from "@/lib/youtube";
import { importedToDocument, loadDocuments, persistDocuments } from "@/lib/transcript-store";
import { trpc } from "@/lib/trpc";
import type { TranscriptDocument, TranscriptSegment } from "@/shared/transcript";
import { wordCount } from "@/shared/transcript";

function fireHaptic(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  if (Platform.OS !== "web") void Haptics.impactAsync(style);
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(value);
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function SourceBadge({ source, colors }: { source: TranscriptDocument["source"]; colors: ReturnType<typeof useColors> }) {
  const automatic = source === "automatic";
  return (
    <View style={[styles.sourceBadge, { backgroundColor: automatic ? colors.warning + "22" : colors.success + "22" }]}>
      <View style={[styles.sourceDot, { backgroundColor: automatic ? colors.warning : colors.success }]} />
      <Text style={[styles.sourceBadgeText, { color: automatic ? colors.warning : colors.success }]}>
        {automatic ? "Automatic captions" : "Creator captions"}
      </Text>
    </View>
  );
}

function LibraryHeader({
  url,
  onChangeUrl,
  onPaste,
  onImport,
  isImporting,
  status,
  colors,
}: {
  url: string;
  onChangeUrl: (value: string) => void;
  onPaste: () => void;
  onImport: () => void;
  isImporting: boolean;
  status: { tone: "error" | "success" | "info"; text: string } | null;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View>
      <View style={styles.topBar}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>TRANSCRIPT WORKSPACE</Text>
          <Text style={[styles.appTitle, { color: colors.foreground }]}>YouTube Transcript Studio</Text>
        </View>
        <View style={[styles.logoMark, { backgroundColor: colors.primary }]}>
          <Text style={styles.logoMarkText}>T</Text>
        </View>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.primary }]}>
        <View style={styles.heroOrbLarge} />
        <View style={styles.heroOrbSmall} />
        <Text style={styles.heroKicker}>PASTE A LINK. START READING.</Text>
        <Text style={styles.heroTitle}>မူရင်းဘာသာအတိုင်း စာသားယူပါ</Text>
        <Text style={styles.heroBody}>
          Video သို့မဟုတ် playlist link ကိုထည့်ပြီး preview, copy, edit နဲ့ DOCX export လုပ်ပါ။ Login မလိုပါ။
        </Text>
      </View>

      <View style={[styles.inputCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.inputLabelRow}>
          <Text style={[styles.inputLabel, { color: colors.foreground }]}>YouTube link</Text>
          <Text style={[styles.inputHint, { color: colors.muted }]}>Video · Playlist</Text>
        </View>
        <View style={[styles.urlInputWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
          <TextInput
            value={url}
            onChangeText={onChangeUrl}
            placeholder="https://youtube.com/watch?v=..."
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={onImport}
            style={[styles.urlInput, { color: colors.foreground }]}
            accessibilityLabel="YouTube video or playlist link"
          />
          <TouchableOpacity onPress={onPaste} style={[styles.pasteButton, { backgroundColor: colors.primary + "16" }]} accessibilityRole="button" accessibilityLabel="Paste link">
            <Text style={[styles.pasteButtonText, { color: colors.primary }]}>Paste</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={onImport}
          disabled={isImporting}
          activeOpacity={0.82}
          style={[styles.primaryButton, { backgroundColor: colors.primary }, isImporting && styles.disabledButton]}
          accessibilityRole="button"
          accessibilityLabel="Get transcript"
        >
          {isImporting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Get transcript</Text>}
          {!isImporting && <Text style={styles.primaryButtonArrow}>→</Text>}
        </TouchableOpacity>
      </View>

      {status && (
        <View style={[styles.statusCard, { backgroundColor: status.tone === "error" ? colors.error + "12" : status.tone === "success" ? colors.success + "12" : colors.primary + "0D" }]}>
          <View style={[styles.statusIcon, { backgroundColor: status.tone === "error" ? colors.error : status.tone === "success" ? colors.success : colors.primary }]}>
            <Text style={styles.statusIconText}>{status.tone === "error" ? "!" : status.tone === "success" ? "✓" : "i"}</Text>
          </View>
          <Text style={[styles.statusText, { color: colors.foreground }]}>{status.text}</Text>
        </View>
      )}

      <View style={styles.sectionHeading}>
        <View>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent transcripts</Text>
          <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>Saved on this device</Text>
        </View>
      </View>
    </View>
  );
}

function EmptyLibrary({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.emptyCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.primary + "14" }]}>
        <Text style={[styles.emptyIconText, { color: colors.primary }]}>▤</Text>
      </View>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Your library is ready</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>Paste a YouTube link above. Imported transcripts and your edits stay on this device.</Text>
    </View>
  );
}

function TranscriptRow({ document, onOpen, colors }: { document: TranscriptDocument; onOpen: () => void; colors: ReturnType<typeof useColors> }) {
  return (
    <TouchableOpacity onPress={onOpen} activeOpacity={0.78} style={[styles.transcriptRow, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel={`Open ${document.title}`}>
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + "14" }]}>
        <Text style={[styles.rowIconText, { color: colors.primary }]}>T</Text>
      </View>
      <View style={styles.rowContent}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: colors.foreground }]}>{document.title}</Text>
        <View style={styles.rowMeta}>
          <Text style={[styles.rowMetaText, { color: colors.muted }]}>{formatSourceLanguage(document.language)}</Text>
          <View style={[styles.metaSeparator, { backgroundColor: colors.border }]} />
          <Text style={[styles.rowMetaText, { color: colors.muted }]}>{formatDate(document.updatedAt)}</Text>
        </View>
      </View>
      <Text style={[styles.rowChevron, { color: colors.muted }]}>›</Text>
    </TouchableOpacity>
  );
}

function SegmentPreview({ segment, colors }: { segment: TranscriptSegment; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={styles.segmentRow}>
      <Text style={[styles.segmentTime, { color: colors.primary }]}>{formatTime(segment.start)}</Text>
      <Text style={[styles.segmentText, { color: colors.foreground }]}>{segment.text}</Text>
    </View>
  );
}

function Workspace({
  document,
  onBack,
  onUpdate,
  colors,
}: {
  document: TranscriptDocument;
  onBack: () => void;
  onUpdate: (document: TranscriptDocument) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState(document.editedText);
  const [showExport, setShowExport] = useState(false);
  const [includeTimestamps, setIncludeTimestamps] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(document.editedText);
  }, [document.id, document.editedText]);

  const saveDraft = async () => {
    const next = { ...document, editedText: draft, updatedAt: Date.now() };
    onUpdate(next);
    setNotice("Changes saved on this device.");
    fireHaptic(Haptics.ImpactFeedbackStyle.Light);
  };

  const copyDraft = async () => {
    await Clipboard.setStringAsync(draft);
    setNotice("Transcript copied to clipboard.");
    fireHaptic(Haptics.ImpactFeedbackStyle.Light);
  };

  const runExport = async () => {
    const exportDocument = { ...document, editedText: draft };
    await exportDocx(exportDocument, includeTimestamps);
    setShowExport(false);
    setNotice("DOCX export is ready to save or share.");
    fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
  };

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView style={styles.workspaceShell} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.workspaceHeader}>
          <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back to transcript library">
            <Text style={[styles.backButtonText, { color: colors.primary }]}>‹</Text>
            <Text style={[styles.backButtonLabel, { color: colors.primary }]}>Library</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowExport(true)} style={[styles.headerExport, { backgroundColor: colors.primary + "14" }]} accessibilityRole="button" accessibilityLabel="Export DOCX">
            <Text style={[styles.headerExportText, { color: colors.primary }]}>DOCX</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.workspaceTitleBlock}>
          <Text style={[styles.workspaceEyebrow, { color: colors.primary }]}>TRANSCRIPT</Text>
          <Text style={[styles.workspaceTitle, { color: colors.foreground }]}>{document.title}</Text>
          <View style={styles.workspaceMetaLine}>
            <Text style={[styles.workspaceLanguage, { color: colors.muted }]}>{formatSourceLanguage(document.language)}</Text>
            <View style={[styles.metaSeparator, { backgroundColor: colors.border }]} />
            <SourceBadge source={document.source} colors={colors} />
          </View>
        </View>

        <View style={[styles.noticeBar, { backgroundColor: colors.warning + "12" }]}>
          <Text style={[styles.noticeBarMark, { color: colors.warning }]}>i</Text>
          <Text style={[styles.noticeBarText, { color: colors.foreground }]}>Captions may contain omissions or recognition errors. You can edit this local copy.</Text>
        </View>

        <View style={[styles.modeSwitch, { backgroundColor: colors.surface }]}>
          <TouchableOpacity onPress={() => setMode("read")} style={[styles.modeOption, mode === "read" && { backgroundColor: colors.background }]} accessibilityRole="tab" accessibilityState={{ selected: mode === "read" }}>
            <Text style={[styles.modeOptionText, { color: mode === "read" ? colors.foreground : colors.muted }]}>Preview</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMode("edit")} style={[styles.modeOption, mode === "edit" && { backgroundColor: colors.background }]} accessibilityRole="tab" accessibilityState={{ selected: mode === "edit" }}>
            <Text style={[styles.modeOptionText, { color: mode === "edit" ? colors.foreground : colors.muted }]}>Edit</Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.transcriptPanel, { borderColor: colors.border, backgroundColor: colors.background }]}>
          {mode === "read" ? (
            <FlatList
              data={document.segments.length ? document.segments : [{ text: draft, start: 0, duration: 0 }]}
              keyExtractor={(item, index) => `${document.id}-${item.start}-${index}`}
              renderItem={({ item }) => <SegmentPreview segment={item} colors={colors} />}
              contentContainerStyle={styles.segmentList}
              showsVerticalScrollIndicator={false}
            />
          ) : (
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              textAlignVertical="top"
              style={[styles.editor, { color: colors.foreground }]}
              placeholder="Edit the transcript here..."
              placeholderTextColor={colors.muted}
              accessibilityLabel="Editable transcript text"
            />
          )}
        </View>

        <View style={styles.workspaceBottom}>
          <View style={styles.countLine}>
            <Text style={[styles.countText, { color: colors.muted }]}>{wordCount(draft).toLocaleString()} words</Text>
            <Text style={[styles.countText, { color: colors.muted }]}>{draft.length.toLocaleString()} characters</Text>
          </View>
          {notice && <Text style={[styles.inlineNotice, { color: colors.success }]}>{notice}</Text>}
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={copyDraft} style={[styles.secondaryAction, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel="Copy transcript">
              <Text style={[styles.secondaryActionIcon, { color: colors.primary }]}>□</Text>
              <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={mode === "edit" ? saveDraft : () => setMode("edit")} style={[styles.primaryAction, { backgroundColor: colors.primary }]} accessibilityRole="button" accessibilityLabel={mode === "edit" ? "Save edits" : "Edit transcript"}>
              <Text style={styles.primaryActionText}>{mode === "edit" ? "Save edits" : "Edit transcript"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={showExport} transparent animationType="slide" onRequestClose={() => setShowExport(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.exportSheet, { backgroundColor: colors.background }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View>
                <Text style={[styles.sheetEyebrow, { color: colors.primary }]}>DOCUMENT EXPORT</Text>
                <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Export as DOCX</Text>
              </View>
              <TouchableOpacity onPress={() => setShowExport(false)} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close export sheet">
                <Text style={[styles.closeButtonText, { color: colors.muted }]}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.sheetBody, { color: colors.muted }]}>Your edited transcript will be packaged as a Word document and opened in the Android share sheet.</Text>
            <TouchableOpacity onPress={() => setIncludeTimestamps((value) => !value)} style={[styles.optionRow, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="checkbox" accessibilityState={{ checked: includeTimestamps }}>
              <View style={[styles.checkbox, { borderColor: includeTimestamps ? colors.primary : colors.border, backgroundColor: includeTimestamps ? colors.primary : "transparent" }]}>
                {includeTimestamps && <Text style={styles.checkboxMark}>✓</Text>}
              </View>
              <View style={styles.optionCopy}>
                <Text style={[styles.optionTitle, { color: colors.foreground }]}>Include timestamps</Text>
                <Text style={[styles.optionSubtitle, { color: colors.muted }]}>Add time markers from the imported captions</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={runExport} style={[styles.primaryButton, { backgroundColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Export DOCX file">
              <Text style={styles.primaryButtonText}>Export DOCX</Text>
              <Text style={styles.primaryButtonArrow}>→</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const [url, setUrl] = useState("");
  const [documents, setDocuments] = useState<TranscriptDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const importMutation = trpc.transcripts.import.useMutation();

  useEffect(() => {
    loadDocuments().then(setDocuments);
  }, []);

  const selectedDocument = useMemo(() => documents.find((item) => item.id === selectedId) ?? null, [documents, selectedId]);

  const handlePaste = async () => {
    const clipboard = await Clipboard.getStringAsync();
    if (!clipboard.trim()) {
      setStatus({ tone: "info", text: "Clipboard ထဲမှာ link မတွေ့ပါ။" });
      return;
    }
    setUrl(clipboard.trim());
    setStatus({ tone: "info", text: "Link ကို paste လုပ်ပြီးပါပြီ။ Get transcript ကိုနှိပ်ပါ။" });
    fireHaptic();
  };

  const handleImport = async () => {
    setStatus(null);
    let parsed: ReturnType<typeof parseYouTubeLink>;
    try {
      parsed = parseYouTubeLink(url);
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "ဒီ link ကို မဖတ်နိုင်ပါ။" });
      return;
    }

    try {
      fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
      const result = await importMutation.mutateAsync({ url: parsed.originalUrl });
      const newDocuments = result.documents.map(importedToDocument);
      const nextDocuments = [...newDocuments, ...documents].slice(0, 100);
      await persistDocuments(nextDocuments);
      setDocuments(nextDocuments);
      setSelectedId(newDocuments[0]?.id ?? null);
      setUrl("");
      setStatus({ tone: "success", text: result.kind === "playlist" ? `${newDocuments.length} videos ကို import လုပ်ပြီးပါပြီ။` : "Transcript ရပါပြီ။ Preview ကိုဖွင့်နေပါတယ်။" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcript မရနိုင်ပါ။ ခဏကြာပြီး ပြန်စမ်းပါ။";
      setStatus({ tone: "error", text: message });
    }
  };

  const handleUpdate = async (nextDocument: TranscriptDocument) => {
    const nextDocuments = documents.map((item) => (item.id === nextDocument.id ? nextDocument : item));
    await persistDocuments(nextDocuments);
    setDocuments(nextDocuments);
  };

  if (selectedDocument) {
    return <Workspace document={selectedDocument} onBack={() => setSelectedId(null)} onUpdate={handleUpdate} colors={colors} />;
  }

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right", "bottom"]}>
      <FlatList
        data={documents}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <TranscriptRow document={item} onOpen={() => setSelectedId(item.id)} colors={colors} />}
        ListHeaderComponent={<LibraryHeader url={url} onChangeUrl={setUrl} onPaste={handlePaste} onImport={handleImport} isImporting={importMutation.isPending} status={status} colors={colors} />}
        ListEmptyComponent={<EmptyLibrary colors={colors} />}
        contentContainerStyle={styles.libraryList}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  libraryList: { paddingBottom: 28, gap: 12 },
  topBar: { paddingTop: 4, paddingBottom: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.6, marginBottom: 5 },
  appTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  logoMark: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", shadowColor: "#101828", shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 3 },
  logoMarkText: { color: "#FFFFFF", fontSize: 22, fontWeight: "900" },
  heroCard: { minHeight: 190, borderRadius: 26, padding: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 14 },
  heroOrbLarge: { position: "absolute", width: 210, height: 210, borderRadius: 105, right: -70, top: -70, backgroundColor: "#FFFFFF18" },
  heroOrbSmall: { position: "absolute", width: 92, height: 92, borderRadius: 46, right: 28, top: 36, backgroundColor: "#FFFFFF10" },
  heroKicker: { color: "#DCEBFF", fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 },
  heroTitle: { color: "#FFFFFF", fontSize: 25, fontWeight: "800", lineHeight: 33, maxWidth: 280, marginBottom: 8 },
  heroBody: { color: "#EAF2FF", fontSize: 13, lineHeight: 20, maxWidth: 310 },
  inputCard: { borderWidth: 1, borderRadius: 22, padding: 16, marginBottom: 14 },
  inputLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  inputLabel: { fontSize: 14, fontWeight: "800" },
  inputHint: { fontSize: 11, fontWeight: "600" },
  urlInputWrap: { minHeight: 52, borderWidth: 1, borderRadius: 14, paddingLeft: 14, paddingRight: 6, flexDirection: "row", alignItems: "center", marginBottom: 12 },
  urlInput: { flex: 1, fontSize: 14, minHeight: 48 },
  pasteButton: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  pasteButtonText: { fontWeight: "800", fontSize: 12 },
  primaryButton: { minHeight: 52, borderRadius: 14, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  primaryButtonArrow: { color: "#FFFFFF", fontSize: 20, lineHeight: 20, fontWeight: "500" },
  disabledButton: { opacity: 0.65 },
  statusCard: { flexDirection: "row", alignItems: "center", borderRadius: 14, padding: 12, gap: 10, marginBottom: 13 },
  statusIcon: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  statusIconText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  statusText: { flex: 1, fontSize: 12, lineHeight: 18, fontWeight: "600" },
  sectionHeading: { paddingTop: 8, paddingBottom: 2 },
  sectionTitle: { fontSize: 18, fontWeight: "800", letterSpacing: -0.2 },
  sectionSubtitle: { fontSize: 12, marginTop: 3 },
  emptyCard: { borderWidth: 1, borderRadius: 20, padding: 20, alignItems: "center", marginTop: 4 },
  emptyIcon: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  emptyIconText: { fontSize: 23, fontWeight: "800" },
  emptyTitle: { fontSize: 16, fontWeight: "800", marginBottom: 5 },
  emptyBody: { fontSize: 12, lineHeight: 18, textAlign: "center", maxWidth: 280 },
  transcriptRow: { minHeight: 82, borderWidth: 1, borderRadius: 18, padding: 13, flexDirection: "row", alignItems: "center", gap: 12 },
  rowIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  rowIconText: { fontSize: 19, fontWeight: "900" },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  rowMetaText: { fontSize: 10, fontWeight: "600" },
  metaSeparator: { width: 3, height: 3, borderRadius: 2 },
  rowChevron: { fontSize: 26, lineHeight: 26, marginLeft: 2 },
  workspaceShell: { flex: 1 },
  workspaceHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 3, paddingBottom: 15 },
  backButton: { flexDirection: "row", alignItems: "center", paddingVertical: 5, paddingRight: 10 },
  backButtonText: { fontSize: 30, lineHeight: 26, marginRight: 5 },
  backButtonLabel: { fontSize: 13, fontWeight: "800" },
  headerExport: { borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8 },
  headerExportText: { fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  workspaceTitleBlock: { paddingBottom: 14 },
  workspaceEyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 6 },
  workspaceTitle: { fontSize: 23, fontWeight: "800", lineHeight: 29, letterSpacing: -0.4 },
  workspaceMetaLine: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 10 },
  workspaceLanguage: { fontSize: 11, fontWeight: "800" },
  sourceBadge: { flexDirection: "row", alignItems: "center", borderRadius: 100, paddingHorizontal: 8, paddingVertical: 4, gap: 5 },
  sourceDot: { width: 6, height: 6, borderRadius: 3 },
  sourceBadgeText: { fontSize: 10, fontWeight: "800" },
  noticeBar: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 13 },
  noticeBarMark: { width: 16, height: 16, borderRadius: 8, textAlign: "center", fontSize: 11, fontWeight: "900", borderWidth: 1, borderColor: "#F79009" },
  noticeBarText: { flex: 1, fontSize: 11, lineHeight: 17, fontWeight: "600" },
  modeSwitch: { flexDirection: "row", borderRadius: 12, padding: 3, marginBottom: 10 },
  modeOption: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  modeOptionText: { fontSize: 12, fontWeight: "800" },
  transcriptPanel: { flex: 1, borderWidth: 1, borderRadius: 18, overflow: "hidden", minHeight: 260 },
  segmentList: { paddingHorizontal: 15, paddingVertical: 14 },
  segmentRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8 },
  segmentTime: { width: 38, fontSize: 10, fontWeight: "800", paddingTop: 3 },
  segmentText: { flex: 1, fontSize: 15, lineHeight: 24 },
  editor: { flex: 1, fontSize: 15, lineHeight: 24, padding: 15, minHeight: 260 },
  workspaceBottom: { paddingTop: 11, paddingBottom: 6 },
  countLine: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  countText: { fontSize: 10, fontWeight: "700" },
  inlineNotice: { fontSize: 11, fontWeight: "700", marginBottom: 7 },
  actionRow: { flexDirection: "row", gap: 9 },
  secondaryAction: { flex: 0.75, minHeight: 50, borderWidth: 1, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  secondaryActionIcon: { fontSize: 19, fontWeight: "700" },
  secondaryActionText: { fontSize: 13, fontWeight: "800" },
  primaryAction: { flex: 1.25, minHeight: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  primaryActionText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#10182888" },
  exportSheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 30 },
  sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: "#D0D5DD", alignSelf: "center", marginBottom: 20 },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  sheetEyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 6 },
  sheetTitle: { fontSize: 23, fontWeight: "800" },
  closeButton: { padding: 3 },
  closeButtonText: { fontSize: 28, lineHeight: 24 },
  sheetBody: { fontSize: 13, lineHeight: 20, marginTop: 11, marginBottom: 16 },
  optionRow: { borderWidth: 1, borderRadius: 15, padding: 12, flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 17 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  checkboxMark: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  optionCopy: { flex: 1 },
  optionTitle: { fontSize: 13, fontWeight: "800" },
  optionSubtitle: { fontSize: 11, marginTop: 3 },
});
