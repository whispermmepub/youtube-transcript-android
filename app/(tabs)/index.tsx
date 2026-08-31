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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { getGeminiApiKey, importDirectTranscript, saveGeminiApiKey } from "@/lib/direct-transcript";
import { exportDocx } from "@/lib/docx-export";
import { importedToDocument, loadDocuments, persistDocuments, textToDocument } from "@/lib/transcript-store";
import { formatSourceLanguage } from "@/lib/youtube";
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
  const label = source === "automatic"
    ? "Automatic captions"
    : source === "creator"
      ? "Creator captions"
      : source === "ai"
        ? "Gemini AI fallback"
        : "Pasted text";
  const color = source === "creator"
    ? colors.success
    : source === "automatic"
      ? colors.primary
      : source === "ai"
        ? colors.warning
        : colors.muted;
  return (
    <View style={[styles.sourceBadge, { backgroundColor: color + "18" }]}>
      <View style={[styles.sourceDot, { backgroundColor: color }]} />
      <Text style={[styles.sourceBadgeText, { color }]}>{label}</Text>
    </View>
  );
}

function TranscriptRow({ document, onOpen, colors }: { document: TranscriptDocument; onOpen: () => void; colors: ReturnType<typeof useColors> }) {
  return (
    <TouchableOpacity
      onPress={onOpen}
      activeOpacity={0.78}
      style={[styles.transcriptRow, { borderColor: colors.border, backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${document.title}`}
    >
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + "14" }]}><Text style={[styles.rowIconText, { color: colors.primary }]}>T</Text></View>
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
  const insets = useSafeAreaInsets();
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
    setNotice("Original transcript restored.");
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
  const displaySegments = normalizedSearch
    ? allSegments.filter((segment) => segment.text.toLocaleLowerCase().includes(normalizedSearch))
    : allSegments;

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        style={[styles.workspaceShell, { paddingBottom: Math.max(insets.bottom, 10) }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
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

        <View style={[styles.searchWrap, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text style={[styles.searchMark, { color: colors.muted }]}>⌕</Text>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search this transcript"
            placeholderTextColor={colors.muted}
            style={[styles.searchInput, { color: colors.foreground }]}
            accessibilityLabel="Search transcript"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")} accessibilityRole="button" accessibilityLabel="Clear transcript search">
              <Text style={[styles.clearSearch, { color: colors.muted }]}>×</Text>
            </TouchableOpacity>
          )}
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
              data={displaySegments}
              keyExtractor={(item, index) => `${document.id}-${index}`}
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
            <Text style={[styles.countText, { color: colors.muted }]}>{normalizedSearch ? `${displaySegments.length} matches` : `${draft.length.toLocaleString()} characters`}</Text>
          </View>
          {notice && <Text style={[styles.inlineNotice, { color: colors.success }]}>{notice}</Text>}
          {draft !== document.originalText && (
            <TouchableOpacity onPress={resetDraft} style={styles.resetButton} accessibilityRole="button" accessibilityLabel="Reset to original transcript">
              <Text style={[styles.resetButtonText, { color: colors.primary }]}>Reset to original</Text>
            </TouchableOpacity>
          )}
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={copyDraft} style={[styles.secondaryAction, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel="Copy transcript">
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
          <View style={[styles.exportSheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 18) + 16 }]}>
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
              <View style={[styles.checkbox, { borderColor: includeTimestamps ? colors.primary : colors.border, backgroundColor: includeTimestamps ? colors.primary : "transparent" }]}>{includeTimestamps && <Text style={styles.checkboxMark}>✓</Text>}</View>
              <View style={styles.optionCopy}>
                <Text style={[styles.optionTitle, { color: colors.foreground }]}>Include timestamps</Text>
                <Text style={[styles.optionSubtitle, { color: colors.muted }]}>Add transcript timestamps to the document</Text>
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

function HomeHeader({
  sourceUrl,
  language,
  onChangeSourceUrl,
  onChangeLanguage,
  onPasteLink,
  onImport,
  isImporting,
  importStage,
  status,
  aiConfigured,
  onOpenAi,
  manualOpen,
  onToggleManual,
  manualTitle,
  manualText,
  onChangeManualTitle,
  onChangeManualText,
  onPasteManual,
  onSaveManual,
  colors,
}: {
  sourceUrl: string;
  language: string;
  onChangeSourceUrl: (value: string) => void;
  onChangeLanguage: (value: string) => void;
  onPasteLink: () => void;
  onImport: () => void;
  isImporting: boolean;
  importStage: string;
  status: { tone: "error" | "success" | "info"; text: string } | null;
  aiConfigured: boolean;
  onOpenAi: () => void;
  manualOpen: boolean;
  onToggleManual: () => void;
  manualTitle: string;
  manualText: string;
  onChangeManualTitle: (value: string) => void;
  onChangeManualText: (value: string) => void;
  onPasteManual: () => void;
  onSaveManual: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View>
      <View style={styles.topBar}>
        <View style={styles.topBarCopy}>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>YOUTUBE TRANSCRIPT STUDIO</Text>
          <Text style={[styles.appTitle, { color: colors.foreground }]}>Link တစ်ခုပဲ ထည့်ပါ</Text>
        </View>
        <View style={[styles.logoMark, { backgroundColor: colors.primary }]}><Text style={styles.logoMarkText}>T</Text></View>
      </View>

      <View style={[styles.heroCard, { backgroundColor: colors.primary }]}>
        <View style={styles.heroOrbLarge} />
        <View style={styles.heroOrbSmall} />
        <Text style={styles.heroKicker}>LINK → TRANSCRIPT → DOCX</Text>
        <Text style={styles.heroTitle}>Caption ရှိရင် AI မသုံးဘူး</Text>
        <Text style={styles.heroBody}>YouTube link ကို paste လုပ်ပါ။ App က captions ကိုအရင်ရှာမယ်။ မရှိမှသာ Gemini AI fallback ကို အသုံးပြုမယ်။</Text>
      </View>

      <View style={[styles.inputCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.inputLabel, { color: colors.foreground }]}>YouTube video</Text>
        <TextInput
          value={sourceUrl}
          onChangeText={onChangeSourceUrl}
          placeholder="https://youtu.be/... or youtube.com/watch?v=..."
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.singleInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          accessibilityLabel="YouTube video link"
        />
        <View style={styles.compactRow}>
          <TextInput
            value={language}
            onChangeText={onChangeLanguage}
            placeholder="Language hint (optional)"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            style={[styles.singleInput, styles.languageInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
            accessibilityLabel="Optional transcript language hint"
          />
          <TouchableOpacity onPress={onPasteLink} style={[styles.pasteLinkButton, { backgroundColor: colors.primary + "16" }]} accessibilityRole="button" accessibilityLabel="Paste YouTube link from clipboard">
            <Text style={[styles.pasteLinkText, { color: colors.primary }]}>Paste link</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onImport} disabled={isImporting} activeOpacity={0.82} style={[styles.primaryButton, { backgroundColor: colors.primary }, isImporting && styles.disabledButton]} accessibilityRole="button" accessibilityLabel="Get transcript">
          {isImporting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Get Transcript</Text>}
          {!isImporting && <Text style={styles.primaryButtonArrow}>→</Text>}
        </TouchableOpacity>
        {isImporting && <Text style={[styles.progressText, { color: colors.muted }]}>{importStage}</Text>}
      </View>

      <TouchableOpacity onPress={onOpenAi} activeOpacity={0.78} style={[styles.aiCard, { borderColor: colors.border, backgroundColor: colors.surface }]} accessibilityRole="button" accessibilityLabel="Configure AI fallback">
        <View style={[styles.aiIcon, { backgroundColor: aiConfigured ? colors.success + "18" : colors.warning + "18" }]}>
          <Text style={{ color: aiConfigured ? colors.success : colors.warning, fontWeight: "900" }}>AI</Text>
        </View>
        <View style={styles.aiCopy}>
          <Text style={[styles.aiTitle, { color: colors.foreground }]}>AI Fallback</Text>
          <Text style={[styles.aiSubtitle, { color: colors.muted }]}>{aiConfigured ? "Gemini key securely saved · only used when captions fail" : "Optional · captions work without any API key"}</Text>
        </View>
        <Text style={[styles.rowChevron, { color: colors.muted }]}>›</Text>
      </TouchableOpacity>

      {status && (
        <View style={[styles.statusCard, { backgroundColor: status.tone === "error" ? colors.error + "12" : status.tone === "success" ? colors.success + "12" : colors.primary + "0D" }]}>
          <View style={[styles.statusIcon, { backgroundColor: status.tone === "error" ? colors.error : status.tone === "success" ? colors.success : colors.primary }]}><Text style={styles.statusIconText}>{status.tone === "error" ? "!" : status.tone === "success" ? "✓" : "i"}</Text></View>
          <Text style={[styles.statusText, { color: colors.foreground }]}>{status.text}</Text>
        </View>
      )}

      <TouchableOpacity onPress={onToggleManual} style={styles.manualToggle} accessibilityRole="button" accessibilityLabel="Toggle manual transcript fallback">
        <Text style={[styles.manualToggleText, { color: colors.primary }]}>{manualOpen ? "Hide manual paste" : "Manual paste fallback"}</Text>
        <Text style={[styles.manualToggleArrow, { color: colors.primary }]}>{manualOpen ? "−" : "+"}</Text>
      </TouchableOpacity>

      {manualOpen && (
        <View style={[styles.manualCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <TextInput value={manualTitle} onChangeText={onChangeManualTitle} placeholder="Document title (optional)" placeholderTextColor={colors.muted} style={[styles.singleInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
          <View style={[styles.manualTextWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
            <TextInput value={manualText} onChangeText={onChangeManualText} placeholder="Paste transcript text here..." placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.manualTextInput, { color: colors.foreground }]} />
            <TouchableOpacity onPress={onPasteManual} style={[styles.smallButton, { backgroundColor: colors.primary + "14" }]}><Text style={[styles.smallButtonText, { color: colors.primary }]}>Paste clipboard</Text></TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onSaveManual} style={[styles.secondaryFullButton, { borderColor: colors.border }]}><Text style={[styles.secondaryFullButtonText, { color: colors.foreground }]}>Save manual transcript</Text></TouchableOpacity>
        </View>
      )}

      <View style={styles.sectionHeading}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent transcripts</Text>
        <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>Stored locally on this device</Text>
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [sourceUrl, setSourceUrl] = useState("");
  const [language, setLanguage] = useState("");
  const [documents, setDocuments] = useState<TranscriptDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importStage, setImportStage] = useState("");
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");
  const [aiConfigured, setAiConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualText, setManualText] = useState("");

  useEffect(() => {
    loadDocuments().then(setDocuments);
    getGeminiApiKey().then((key) => setAiConfigured(Boolean(key)));
  }, []);

  const selectedDocument = useMemo(() => documents.find((item) => item.id === selectedId) ?? null, [documents, selectedId]);

  const handlePasteLink = async () => {
    const value = (await Clipboard.getStringAsync()).trim();
    if (!value) {
      setStatus({ tone: "info", text: "Clipboard ထဲမှာ link မတွေ့ပါ။" });
      return;
    }
    setSourceUrl(value);
    setStatus(null);
    fireHaptic();
  };

  const handleImport = async () => {
    if (!sourceUrl.trim()) {
      setStatus({ tone: "error", text: "YouTube video link ကို အရင်ထည့်ပါ။" });
      return;
    }
    setIsImporting(true);
    setStatus(null);
    setImportStage("YouTube link ကို စစ်နေပါတယ်…");
    try {
      const result = await importDirectTranscript(sourceUrl, language, (stage) => {
        setImportStage(stage === "checking"
          ? "YouTube link ကို စစ်နေပါတယ်…"
          : stage === "captions"
            ? "Creator / automatic captions ကို အရင်ရှာနေပါတယ်…"
            : "Caption မတွေ့လို့ Gemini AI fallback ကို အသုံးပြုနေပါတယ်…");
      });
      const document = importedToDocument(result);
      const next = [document, ...documents.filter((item) => item.videoId !== document.videoId)].slice(0, 100);
      await persistDocuments(next);
      setDocuments(next);
      setSelectedId(document.id);
      setSourceUrl("");
      setStatus({ tone: "success", text: result.provider === "youtube" ? "YouTube caption နဲ့ပြီးပါပြီ — AI မသုံးပါ။" : "Caption မရှိလို့ Gemini AI fallback နဲ့ transcript ထုတ်ပြီးပါပြီ။" });
      fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcript မရပါ။";
      setStatus({ tone: "error", text: message });
      if ((error as Error & { code?: string })?.code === "AI_KEY_REQUIRED") setShowAiSettings(true);
    } finally {
      setIsImporting(false);
      setImportStage("");
    }
  };

  const handleOpenAiSettings = async () => {
    setGeminiKeyDraft("");
    setShowAiSettings(true);
  };

  const handleSaveAiKey = async () => {
    if (!geminiKeyDraft.trim()) {
      setStatus({ tone: "error", text: "Gemini API key ကို ထည့်ပါ။" });
      return;
    }
    setSavingKey(true);
    try {
      await saveGeminiApiKey(geminiKeyDraft);
      setAiConfigured(true);
      setGeminiKeyDraft("");
      setShowAiSettings(false);
      setStatus({ tone: "success", text: "Gemini key ကို ဖုန်း SecureStore ထဲသိမ်းပြီးပါပြီ။ Caption မရမှသာ သုံးပါမယ်။" });
      fireHaptic();
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveAiKey = async () => {
    await saveGeminiApiKey("");
    setAiConfigured(false);
    setGeminiKeyDraft("");
    setShowAiSettings(false);
    setStatus({ tone: "info", text: "Gemini key ကို ဖုန်းထဲက ဖယ်ပြီးပါပြီ။ Captions ကတော့ ဆက်သုံးလို့ရပါတယ်။" });
  };

  const handlePasteManual = async () => {
    const value = (await Clipboard.getStringAsync()).trim();
    if (!value) {
      setStatus({ tone: "info", text: "Clipboard ထဲမှာ transcript မတွေ့ပါ။" });
      return;
    }
    setManualText(value);
    fireHaptic();
  };

  const handleSaveManual = async () => {
    if (!manualText.trim()) {
      setStatus({ tone: "error", text: "Manual transcript စာသားကို paste လုပ်ပါ။" });
      return;
    }
    const document = textToDocument(manualText, manualTitle, sourceUrl, language);
    const next = [document, ...documents].slice(0, 100);
    await persistDocuments(next);
    setDocuments(next);
    setSelectedId(document.id);
    setManualText("");
    setManualTitle("");
    setManualOpen(false);
    fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleUpdate = async (nextDocument: TranscriptDocument) => {
    const nextDocuments = documents.map((item) => item.id === nextDocument.id ? nextDocument : item);
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
        ListHeaderComponent={(
          <HomeHeader
            sourceUrl={sourceUrl}
            language={language}
            onChangeSourceUrl={setSourceUrl}
            onChangeLanguage={setLanguage}
            onPasteLink={handlePasteLink}
            onImport={handleImport}
            isImporting={isImporting}
            importStage={importStage}
            status={status}
            aiConfigured={aiConfigured}
            onOpenAi={handleOpenAiSettings}
            manualOpen={manualOpen}
            onToggleManual={() => setManualOpen((value) => !value)}
            manualTitle={manualTitle}
            manualText={manualText}
            onChangeManualTitle={setManualTitle}
            onChangeManualText={setManualText}
            onPasteManual={handlePasteManual}
            onSaveManual={handleSaveManual}
            colors={colors}
          />
        )}
        ListEmptyComponent={(
          <View style={[styles.emptyCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Library အဆင်သင့်ပါပြီ</Text>
            <Text style={[styles.emptyBody, { color: colors.muted }]}>အပေါ်မှာ YouTube link ထည့်ပြီး Get Transcript ကိုနှိပ်ပါ။</Text>
          </View>
        )}
        contentContainerStyle={[styles.libraryList, { paddingBottom: Math.max(insets.bottom, 12) + 24 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      <Modal visible={showAiSettings} transparent animationType="slide" onRequestClose={() => setShowAiSettings(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.exportSheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 18) + 16 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[styles.sheetEyebrow, { color: colors.primary }]}>OPTIONAL AI FALLBACK</Text>
                <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Gemini API key</Text>
              </View>
              <TouchableOpacity onPress={() => setShowAiSettings(false)} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close AI settings"><Text style={[styles.closeButtonText, { color: colors.muted }]}>×</Text></TouchableOpacity>
            </View>
            <Text style={[styles.sheetBody, { color: colors.muted }]}>Caption ရှိတဲ့ video တွေမှာ Gemini ကို လုံးဝမခေါ်ပါ။ Key ကို GitHub/APK ထဲမထည့်ဘဲ ဒီဖုန်း SecureStore ထဲပဲ သိမ်းထားပါတယ်။</Text>
            <TextInput
              value={geminiKeyDraft}
              onChangeText={setGeminiKeyDraft}
              placeholder={aiConfigured ? "New key ထည့်မှ လက်ရှိ key ကိုပြောင်းမယ်" : "Paste Gemini API key"}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={[styles.keyInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]}
              accessibilityLabel="Gemini API key"
            />
            <TouchableOpacity onPress={handleSaveAiKey} disabled={savingKey} style={[styles.primaryButton, { backgroundColor: colors.primary }, savingKey && styles.disabledButton]}>
              {savingKey ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>{aiConfigured ? "Replace secure key" : "Save secure key"}</Text>}
            </TouchableOpacity>
            {aiConfigured && (
              <TouchableOpacity onPress={handleRemoveAiKey} style={styles.removeKeyButton}><Text style={[styles.removeKeyText, { color: colors.error }]}>Remove saved key</Text></TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  libraryList: { gap: 12 },
  topBar: { paddingTop: 4, paddingBottom: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  topBarCopy: { flex: 1, paddingRight: 12 },
  eyebrow: { fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 },
  appTitle: { fontSize: 23, fontWeight: "800", letterSpacing: -0.5 },
  logoMark: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center", elevation: 3 },
  logoMarkText: { color: "#FFFFFF", fontSize: 22, fontWeight: "900" },
  heroCard: { minHeight: 182, borderRadius: 26, padding: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 14 },
  heroOrbLarge: { position: "absolute", width: 210, height: 210, borderRadius: 105, right: -70, top: -70, backgroundColor: "#FFFFFF18" },
  heroOrbSmall: { position: "absolute", width: 92, height: 92, borderRadius: 46, right: 28, top: 36, backgroundColor: "#FFFFFF10" },
  heroKicker: { color: "#DCEBFF", fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 },
  heroTitle: { color: "#FFFFFF", fontSize: 25, fontWeight: "800", lineHeight: 33, maxWidth: 310, marginBottom: 8 },
  heroBody: { color: "#EAF2FF", fontSize: 13, lineHeight: 20, maxWidth: 340 },
  inputCard: { borderWidth: 1, borderRadius: 22, padding: 16, marginBottom: 12 },
  inputLabel: { fontSize: 14, fontWeight: "800", marginBottom: 10 },
  singleInput: { minHeight: 48, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, fontSize: 13, marginBottom: 9 },
  compactRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  languageInput: { flex: 1 },
  pasteLinkButton: { minHeight: 48, borderRadius: 13, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  pasteLinkText: { fontSize: 12, fontWeight: "800" },
  primaryButton: { minHeight: 52, borderRadius: 14, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  primaryButtonArrow: { color: "#FFFFFF", fontSize: 20, lineHeight: 20 },
  disabledButton: { opacity: 0.65 },
  progressText: { marginTop: 10, fontSize: 11, lineHeight: 17, fontWeight: "600", textAlign: "center" },
  aiCard: { borderWidth: 1, borderRadius: 18, padding: 13, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  aiIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  aiCopy: { flex: 1 },
  aiTitle: { fontSize: 14, fontWeight: "800" },
  aiSubtitle: { fontSize: 11, lineHeight: 16, marginTop: 3 },
  statusCard: { flexDirection: "row", alignItems: "center", borderRadius: 14, padding: 12, gap: 10, marginBottom: 12 },
  statusIcon: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  statusIconText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  statusText: { flex: 1, fontSize: 12, lineHeight: 18, fontWeight: "600" },
  manualToggle: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, marginBottom: 6 },
  manualToggleText: { fontSize: 12, fontWeight: "800" },
  manualToggleArrow: { fontSize: 20, fontWeight: "700" },
  manualCard: { borderWidth: 1, borderRadius: 18, padding: 13, marginBottom: 12 },
  manualTextWrap: { minHeight: 150, borderWidth: 1, borderRadius: 13, padding: 4, marginBottom: 10 },
  manualTextInput: { flex: 1, minHeight: 100, padding: 10, fontSize: 14, lineHeight: 21 },
  smallButton: { alignSelf: "flex-end", borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, marginRight: 5, marginBottom: 5 },
  smallButtonText: { fontSize: 11, fontWeight: "800" },
  secondaryFullButton: { minHeight: 46, borderWidth: 1, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  secondaryFullButtonText: { fontSize: 13, fontWeight: "800" },
  sectionHeading: { paddingTop: 8, paddingBottom: 2 },
  sectionTitle: { fontSize: 18, fontWeight: "800", letterSpacing: -0.2 },
  sectionSubtitle: { fontSize: 12, marginTop: 3 },
  emptyCard: { borderWidth: 1, borderRadius: 20, padding: 20, alignItems: "center", marginTop: 4 },
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
  rowChevron: { fontSize: 26, lineHeight: 26 },
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
  workspaceMetaLine: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 10, flexWrap: "wrap" },
  workspaceLanguage: { fontSize: 11, fontWeight: "800" },
  sourceBadge: { flexDirection: "row", alignItems: "center", borderRadius: 100, paddingHorizontal: 8, paddingVertical: 4, gap: 5 },
  sourceDot: { width: 6, height: 6, borderRadius: 3 },
  sourceBadgeText: { fontSize: 10, fontWeight: "800" },
  searchWrap: { minHeight: 44, borderWidth: 1, borderRadius: 13, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", marginBottom: 10 },
  searchMark: { fontSize: 20, width: 23, textAlign: "center" },
  searchInput: { flex: 1, minHeight: 40, paddingHorizontal: 7, fontSize: 12 },
  clearSearch: { fontSize: 22, paddingHorizontal: 4, lineHeight: 22 },
  modeSwitch: { flexDirection: "row", borderRadius: 12, padding: 3, marginBottom: 10 },
  modeOption: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  modeOptionText: { fontSize: 12, fontWeight: "800" },
  transcriptPanel: { flex: 1, borderWidth: 1, borderRadius: 18, overflow: "hidden", minHeight: 260 },
  segmentList: { paddingHorizontal: 15, paddingVertical: 14 },
  segmentRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8 },
  segmentTime: { width: 42, fontSize: 10, fontWeight: "800", paddingTop: 3 },
  segmentText: { flex: 1, fontSize: 15, lineHeight: 24 },
  editor: { flex: 1, fontSize: 15, lineHeight: 24, padding: 15, minHeight: 260 },
  workspaceBottom: { paddingTop: 11 },
  countLine: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  countText: { fontSize: 10, fontWeight: "700" },
  inlineNotice: { fontSize: 11, fontWeight: "700", marginBottom: 7 },
  resetButton: { alignSelf: "flex-start", paddingVertical: 4, marginBottom: 7 },
  resetButtonText: { fontSize: 11, fontWeight: "800" },
  actionRow: { flexDirection: "row", gap: 9 },
  secondaryAction: { flex: 0.75, minHeight: 50, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  secondaryActionText: { fontSize: 13, fontWeight: "800" },
  primaryAction: { flex: 1.25, minHeight: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  primaryActionText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#10182888" },
  exportSheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20 },
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
  keyInput: { minHeight: 50, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, marginBottom: 12, fontSize: 13 },
  removeKeyButton: { alignSelf: "center", paddingHorizontal: 14, paddingVertical: 12, marginTop: 4 },
  removeKeyText: { fontSize: 12, fontWeight: "800" },
});
