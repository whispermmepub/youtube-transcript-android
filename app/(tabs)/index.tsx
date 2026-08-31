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
import { formatSourceLanguage } from "@/lib/youtube";
import { loadDocuments, persistDocuments, textToDocument } from "@/lib/transcript-store";
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
  const pasted = source === "pasted";
  const color = automatic ? colors.warning : pasted ? colors.primary : colors.success;
  return (
    <View style={[styles.sourceBadge, { backgroundColor: color + "18" }]}>
      <View style={[styles.sourceDot, { backgroundColor: color }]} />
      <Text style={[styles.sourceBadgeText, { color }]}>{automatic ? "Automatic captions" : pasted ? "Pasted text" : "Creator captions"}</Text>
    </View>
  );
}

function LibraryHeader({
  title,
  language,
  sourceUrl,
  transcript,
  onChangeTitle,
  onChangeLanguage,
  onChangeSourceUrl,
  onChangeTranscript,
  onPasteTranscript,
  onSave,
  isSaving,
  status,
  colors,
}: {
  title: string;
  language: string;
  sourceUrl: string;
  transcript: string;
  onChangeTitle: (value: string) => void;
  onChangeLanguage: (value: string) => void;
  onChangeSourceUrl: (value: string) => void;
  onChangeTranscript: (value: string) => void;
  onPasteTranscript: () => void;
  onSave: () => void;
  isSaving: boolean;
  status: { tone: "error" | "success" | "info"; text: string } | null;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View>
      <View style={styles.topBar}>
        <View style={styles.topBarCopy}>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>LOCAL TRANSCRIPT STUDIO</Text>
          <Text style={[styles.appTitle, { color: colors.foreground }]}>YouTube Transcript Studio</Text>
        </View>
        <View style={[styles.logoMark, { backgroundColor: colors.primary }]}><Text style={styles.logoMarkText}>T</Text></View>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.primary }]}>
        <View style={styles.heroOrbLarge} />
        <View style={styles.heroOrbSmall} />
        <Text style={styles.heroKicker}>PASTE. POLISH. EXPORT.</Text>
        <Text style={styles.heroTitle}>Transcript ကို ကိုယ်တိုင်ထိန်းချုပ်ပါ</Text>
        <Text style={styles.heroBody}>YouTube ကနေ copy လုပ်ထားတဲ့ transcript ကို paste လုပ်ပြီး ဖတ်၊ ပြင်၊ copy နဲ့ DOCX export လုပ်ပါ။ Key နဲ့ login မလိုပါ။</Text>
      </View>

      <View style={[styles.inputCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.inputLabelRow}>
          <Text style={[styles.inputLabel, { color: colors.foreground }]}>New transcript</Text>
          <Text style={[styles.inputHint, { color: colors.muted }]}>Saved on this device</Text>
        </View>
        <TextInput value={title} onChangeText={onChangeTitle} placeholder="Document title" placeholderTextColor={colors.muted} style={[styles.singleInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} accessibilityLabel="Document title" />
        <View style={styles.compactInputRow}>
          <TextInput value={language} onChangeText={onChangeLanguage} placeholder="Language (e.g. my)" placeholderTextColor={colors.muted} autoCapitalize="none" style={[styles.singleInput, styles.languageInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} accessibilityLabel="Transcript language" />
          <TextInput value={sourceUrl} onChangeText={onChangeSourceUrl} placeholder="YouTube link (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[styles.singleInput, styles.sourceInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} accessibilityLabel="Optional YouTube source link" />
        </View>
        <View style={[styles.transcriptInputWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
          <TextInput value={transcript} onChangeText={onChangeTranscript} placeholder="Paste transcript text here..." placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.transcriptInput, { color: colors.foreground }]} accessibilityLabel="Transcript text to paste" />
          <TouchableOpacity onPress={onPasteTranscript} style={[styles.pasteButton, { backgroundColor: colors.primary + "16" }]} accessibilityRole="button" accessibilityLabel="Paste transcript from clipboard">
            <Text style={[styles.pasteButtonText, { color: colors.primary }]}>Paste from clipboard</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onSave} disabled={isSaving} activeOpacity={0.82} style={[styles.primaryButton, { backgroundColor: colors.primary }, isSaving && styles.disabledButton]} accessibilityRole="button" accessibilityLabel="Save transcript">
          {isSaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save transcript</Text>}
          {!isSaving && <Text style={styles.primaryButtonArrow}>→</Text>}
        </TouchableOpacity>
      </View>

      {status && (
        <View style={[styles.statusCard, { backgroundColor: status.tone === "error" ? colors.error + "12" : status.tone === "success" ? colors.success + "12" : colors.primary + "0D" }]}>
          <View style={[styles.statusIcon, { backgroundColor: status.tone === "error" ? colors.error : status.tone === "success" ? colors.success : colors.primary }]}><Text style={styles.statusIconText}>{status.tone === "error" ? "!" : status.tone === "success" ? "✓" : "i"}</Text></View>
          <Text style={[styles.statusText, { color: colors.foreground }]}>{status.text}</Text>
        </View>
      )}

      <View style={styles.sectionHeading}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent transcripts</Text>
        <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>Local history · no account required</Text>
      </View>
    </View>
  );
}

function EmptyLibrary({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.emptyCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.primary + "14" }]}><Text style={[styles.emptyIconText, { color: colors.primary }]}>▤</Text></View>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Your library is ready</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>Copy a transcript from YouTube, paste it above, then save it for reading and editing.</Text>
    </View>
  );
}

function TranscriptRow({ document, onOpen, colors }: { document: TranscriptDocument; onOpen: () => void; colors: ReturnType<typeof useColors> }) {
  return (
    <TouchableOpacity onPress={onOpen} activeOpacity={0.78} style={[styles.transcriptRow, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel={`Open ${document.title}`}>
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + "14" }]}><Text style={[styles.rowIconText, { color: colors.primary }]}>T</Text></View>
      <View style={styles.rowContent}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: colors.foreground }]}>{document.title}</Text>
        <View style={styles.rowMeta}><Text style={[styles.rowMetaText, { color: colors.muted }]}>{formatSourceLanguage(document.language)}</Text><View style={[styles.metaSeparator, { backgroundColor: colors.border }]} /><Text style={[styles.rowMetaText, { color: colors.muted }]}>{formatDate(document.updatedAt)}</Text></View>
      </View>
      <Text style={[styles.rowChevron, { color: colors.muted }]}>›</Text>
    </TouchableOpacity>
  );
}

function SegmentPreview({ segment, colors }: { segment: TranscriptSegment; colors: ReturnType<typeof useColors> }) {
  return <View style={styles.segmentRow}><Text style={[styles.segmentTime, { color: colors.primary }]}>{formatTime(segment.start)}</Text><Text style={[styles.segmentText, { color: colors.foreground }]}>{segment.text}</Text></View>;
}

function Workspace({ document, onBack, onUpdate, colors }: { document: TranscriptDocument; onBack: () => void; onUpdate: (document: TranscriptDocument) => void; colors: ReturnType<typeof useColors> }) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState(document.editedText);
  const [showExport, setShowExport] = useState(false);
  const [includeTimestamps, setIncludeTimestamps] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => setDraft(document.editedText), [document.id, document.editedText]);

  const saveDraft = async () => {
    onUpdate({ ...document, editedText: draft, updatedAt: Date.now() });
    setNotice("Changes saved on this device.");
    fireHaptic();
  };

  const copyDraft = async () => {
    await Clipboard.setStringAsync(draft);
    setNotice("Transcript copied to clipboard.");
    fireHaptic();
  };

  const resetDraft = async () => {
    setDraft(document.originalText);
    onUpdate({ ...document, editedText: document.originalText, updatedAt: Date.now() });
    setNotice("Original pasted text restored.");
    fireHaptic();
  };

  const runExport = async () => {
    try {
      await exportDocx({ ...document, editedText: draft }, includeTimestamps);
      setShowExport(false);
      setNotice("DOCX export is ready to save or share.");
      fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      setNotice("DOCX export failed. Please try again.");
    }
  };

  const allSegments = draft === document.originalText && document.segments.length > 0
    ? document.segments
    : draft.split(/\r?\n/u).filter(Boolean).map((text, index) => ({ text, start: index, duration: 0 }));
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const displaySegments = normalizedSearch ? allSegments.filter((segment) => segment.text.toLocaleLowerCase().includes(normalizedSearch)) : allSegments;

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView style={styles.workspaceShell} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.workspaceHeader}>
          <TouchableOpacity onPress={onBack} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back to transcript library"><Text style={[styles.backButtonText, { color: colors.primary }]}>‹</Text><Text style={[styles.backButtonLabel, { color: colors.primary }]}>Library</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setShowExport(true)} style={[styles.headerExport, { backgroundColor: colors.primary + "14" }]} accessibilityRole="button" accessibilityLabel="Export DOCX"><Text style={[styles.headerExportText, { color: colors.primary }]}>DOCX</Text></TouchableOpacity>
        </View>
        <View style={styles.workspaceTitleBlock}><Text style={[styles.workspaceEyebrow, { color: colors.primary }]}>TRANSCRIPT</Text><Text style={[styles.workspaceTitle, { color: colors.foreground }]}>{document.title}</Text><View style={styles.workspaceMetaLine}><Text style={[styles.workspaceLanguage, { color: colors.muted }]}>{formatSourceLanguage(document.language)}</Text><View style={[styles.metaSeparator, { backgroundColor: colors.border }]} /><SourceBadge source={document.source} colors={colors} /></View></View>
        <View style={[styles.noticeBar, { backgroundColor: colors.primary + "0D" }]}><Text style={[styles.noticeBarMark, { color: colors.primary }]}>i</Text><Text style={[styles.noticeBarText, { color: colors.foreground }]}>This transcript is stored locally. Edit it freely, then export your final copy.</Text></View>
        <View style={[styles.searchWrap, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={[styles.searchMark, { color: colors.muted }]}>⌕</Text><TextInput value={searchQuery} onChangeText={setSearchQuery} placeholder="Search this transcript" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} accessibilityLabel="Search transcript" />{searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery("")} accessibilityRole="button" accessibilityLabel="Clear transcript search"><Text style={[styles.clearSearch, { color: colors.muted }]}>×</Text></TouchableOpacity>}</View>
        <View style={[styles.modeSwitch, { backgroundColor: colors.surface }]}><TouchableOpacity onPress={() => setMode("read")} style={[styles.modeOption, mode === "read" && { backgroundColor: colors.background }]} accessibilityRole="tab" accessibilityState={{ selected: mode === "read" }}><Text style={[styles.modeOptionText, { color: mode === "read" ? colors.foreground : colors.muted }]}>Preview</Text></TouchableOpacity><TouchableOpacity onPress={() => setMode("edit")} style={[styles.modeOption, mode === "edit" && { backgroundColor: colors.background }]} accessibilityRole="tab" accessibilityState={{ selected: mode === "edit" }}><Text style={[styles.modeOptionText, { color: mode === "edit" ? colors.foreground : colors.muted }]}>Edit</Text></TouchableOpacity></View>
        <View style={[styles.transcriptPanel, { borderColor: colors.border, backgroundColor: colors.background }]}>{mode === "read" ? <FlatList data={displaySegments} keyExtractor={(item, index) => `${document.id}-${index}`} renderItem={({ item }) => <SegmentPreview segment={item} colors={colors} />} contentContainerStyle={styles.segmentList} showsVerticalScrollIndicator={false} /> : <TextInput value={draft} onChangeText={setDraft} multiline textAlignVertical="top" style={[styles.editor, { color: colors.foreground }]} placeholder="Edit the transcript here..." placeholderTextColor={colors.muted} accessibilityLabel="Editable transcript text" />}</View>
        <View style={styles.workspaceBottom}><View style={styles.countLine}><Text style={[styles.countText, { color: colors.muted }]}>{wordCount(draft).toLocaleString()} words</Text><Text style={[styles.countText, { color: colors.muted }]}>{normalizedSearch ? `${displaySegments.length} matches` : `${draft.length.toLocaleString()} characters`}</Text></View>{notice && <Text style={[styles.inlineNotice, { color: colors.success }]}>{notice}</Text>}{draft !== document.originalText && <TouchableOpacity onPress={resetDraft} style={styles.resetButton} accessibilityRole="button" accessibilityLabel="Reset to original pasted text"><Text style={[styles.resetButtonText, { color: colors.primary }]}>Reset to original</Text></TouchableOpacity>}<View style={styles.actionRow}><TouchableOpacity onPress={copyDraft} style={[styles.secondaryAction, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel="Copy transcript"><Text style={[styles.secondaryActionIcon, { color: colors.primary }]}>□</Text><Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Copy</Text></TouchableOpacity><TouchableOpacity onPress={mode === "edit" ? saveDraft : () => setMode("edit")} style={[styles.primaryAction, { backgroundColor: colors.primary }]} accessibilityRole="button" accessibilityLabel={mode === "edit" ? "Save edits" : "Edit transcript"}><Text style={styles.primaryActionText}>{mode === "edit" ? "Save edits" : "Edit transcript"}</Text></TouchableOpacity></View></View>
      </KeyboardAvoidingView>
      <Modal visible={showExport} transparent animationType="slide" onRequestClose={() => setShowExport(false)}><View style={styles.modalBackdrop}><View style={[styles.exportSheet, { backgroundColor: colors.background }]}><View style={styles.sheetHandle} /><View style={styles.sheetHeader}><View><Text style={[styles.sheetEyebrow, { color: colors.primary }]}>DOCUMENT EXPORT</Text><Text style={[styles.sheetTitle, { color: colors.foreground }]}>Export as DOCX</Text></View><TouchableOpacity onPress={() => setShowExport(false)} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close export sheet"><Text style={[styles.closeButtonText, { color: colors.muted }]}>×</Text></TouchableOpacity></View><Text style={[styles.sheetBody, { color: colors.muted }]}>Your edited transcript will be packaged as a Word document and opened in the Android share sheet.</Text><TouchableOpacity onPress={() => setIncludeTimestamps((value) => !value)} style={[styles.optionRow, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="checkbox" accessibilityState={{ checked: includeTimestamps }}><View style={[styles.checkbox, { borderColor: includeTimestamps ? colors.primary : colors.border, backgroundColor: includeTimestamps ? colors.primary : "transparent" }]}>{includeTimestamps && <Text style={styles.checkboxMark}>✓</Text>}</View><View style={styles.optionCopy}><Text style={[styles.optionTitle, { color: colors.foreground }]}>Include timestamps</Text><Text style={[styles.optionSubtitle, { color: colors.muted }]}>Add the imported line markers to the document</Text></View></TouchableOpacity><TouchableOpacity onPress={runExport} style={[styles.primaryButton, { backgroundColor: colors.primary }]} accessibilityRole="button" accessibilityLabel="Export DOCX file"><Text style={styles.primaryButtonText}>Export DOCX</Text><Text style={styles.primaryButtonArrow}>→</Text></TouchableOpacity></View></View></Modal>
    </ScreenContainer>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [transcript, setTranscript] = useState("");
  const [documents, setDocuments] = useState<TranscriptDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => { loadDocuments().then(setDocuments); }, []);
  const selectedDocument = useMemo(() => documents.find((item) => item.id === selectedId) ?? null, [documents, selectedId]);

  const handlePasteTranscript = async () => {
    const clipboard = await Clipboard.getStringAsync();
    if (!clipboard.trim()) { setStatus({ tone: "info", text: "Clipboard ထဲမှာ transcript မတွေ့ပါ။" }); return; }
    setTranscript(clipboard.trim());
    setStatus({ tone: "info", text: "Transcript ကို paste လုပ်ပြီးပါပြီ။ Save transcript ကိုနှိပ်ပါ။" });
    fireHaptic();
  };

  const handleSave = async () => {
    if (!transcript.trim()) { setStatus({ tone: "error", text: "Transcript စာသားကို paste လုပ်ပါ။" }); return; }
    setIsSaving(true);
    try {
      const document = textToDocument(transcript, title, sourceUrl, language);
      const nextDocuments = [document, ...documents].slice(0, 100);
      await persistDocuments(nextDocuments);
      setDocuments(nextDocuments);
      setSelectedId(document.id);
      setTitle(""); setLanguage(""); setSourceUrl(""); setTranscript("");
      setStatus({ tone: "success", text: "Transcript ကို local library ထဲသိမ်းပြီးပါပြီ။" });
      fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    } finally { setIsSaving(false); }
  };

  const handleUpdate = async (nextDocument: TranscriptDocument) => {
    const nextDocuments = documents.map((item) => item.id === nextDocument.id ? nextDocument : item);
    await persistDocuments(nextDocuments);
    setDocuments(nextDocuments);
  };

  if (selectedDocument) return <Workspace document={selectedDocument} onBack={() => setSelectedId(null)} onUpdate={handleUpdate} colors={colors} />;

  return <ScreenContainer className="px-5" edges={["top", "left", "right", "bottom"]}><FlatList data={documents} keyExtractor={(item) => item.id} renderItem={({ item }) => <TranscriptRow document={item} onOpen={() => setSelectedId(item.id)} colors={colors} />} ListHeaderComponent={<LibraryHeader title={title} language={language} sourceUrl={sourceUrl} transcript={transcript} onChangeTitle={setTitle} onChangeLanguage={setLanguage} onChangeSourceUrl={setSourceUrl} onChangeTranscript={setTranscript} onPasteTranscript={handlePasteTranscript} onSave={handleSave} isSaving={isSaving} status={status} colors={colors} />} ListEmptyComponent={<EmptyLibrary colors={colors} />} contentContainerStyle={styles.libraryList} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" /> </ScreenContainer>;
}

const styles = StyleSheet.create({
  libraryList: { paddingBottom: 28, gap: 12 },
  topBar: { paddingTop: 4, paddingBottom: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  topBarCopy: { flex: 1 },
  eyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.6, marginBottom: 5 },
  appTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  logoMark: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", elevation: 3 },
  logoMarkText: { color: "#FFFFFF", fontSize: 22, fontWeight: "900" },
  heroCard: { minHeight: 182, borderRadius: 26, padding: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 14 },
  heroOrbLarge: { position: "absolute", width: 210, height: 210, borderRadius: 105, right: -70, top: -70, backgroundColor: "#FFFFFF18" },
  heroOrbSmall: { position: "absolute", width: 92, height: 92, borderRadius: 46, right: 28, top: 36, backgroundColor: "#FFFFFF10" },
  heroKicker: { color: "#DCEBFF", fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 },
  heroTitle: { color: "#FFFFFF", fontSize: 25, fontWeight: "800", lineHeight: 33, maxWidth: 300, marginBottom: 8 },
  heroBody: { color: "#EAF2FF", fontSize: 13, lineHeight: 20, maxWidth: 330 },
  inputCard: { borderWidth: 1, borderRadius: 22, padding: 16, marginBottom: 14 },
  inputLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  inputLabel: { fontSize: 14, fontWeight: "800" },
  inputHint: { fontSize: 11, fontWeight: "600" },
  singleInput: { minHeight: 46, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, fontSize: 13, marginBottom: 9 },
  compactInputRow: { flexDirection: "row", gap: 8 },
  languageInput: { flex: 0.78 },
  sourceInput: { flex: 1.22 },
  transcriptInputWrap: { minHeight: 160, borderWidth: 1, borderRadius: 14, padding: 3, marginBottom: 12 },
  transcriptInput: { flex: 1, minHeight: 110, padding: 11, fontSize: 14, lineHeight: 22 },
  pasteButton: { alignSelf: "flex-end", borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8, marginRight: 7, marginBottom: 6 },
  pasteButtonText: { fontWeight: "800", fontSize: 11 },
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
  rowContent: { flex: 1, minWidth: 0 },
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
  noticeBar: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 10 },
  searchWrap: { minHeight: 44, borderWidth: 1, borderRadius: 13, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", marginBottom: 10 },
  searchMark: { fontSize: 20, width: 23, textAlign: "center" },
  searchInput: { flex: 1, minHeight: 40, paddingHorizontal: 7, fontSize: 12 },
  clearSearch: { fontSize: 22, paddingHorizontal: 4, lineHeight: 22 },
  noticeBarMark: { width: 16, height: 16, borderRadius: 8, textAlign: "center", fontSize: 11, fontWeight: "900", borderWidth: 1, borderColor: "#98A2B3" },
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
  resetButton: { alignSelf: "flex-start", paddingVertical: 4, marginBottom: 7 },
  resetButtonText: { fontSize: 11, fontWeight: "800" },
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
