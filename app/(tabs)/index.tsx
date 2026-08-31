import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import {
  getConfiguredProviders,
  saveProviderKey,
  type CloudProvider,
} from "@/lib/ai-providers";
import { importDirectTranscript } from "@/lib/direct-transcript";
import { exportDocx } from "@/lib/docx-export";
import {
  ensureOfflineModel,
  importMediaFile,
  isOfflineModelReady,
  pickTranscriptFile,
  removeOfflineModel,
  type FileImportMode,
} from "@/lib/local-media";
import { importedToDocument, loadDocuments, persistDocuments, textToDocument } from "@/lib/transcript-store";
import { formatSourceLanguage } from "@/lib/youtube";
import type { TranscriptDocument, TranscriptProvider, TranscriptSegment } from "@/shared/transcript";
import { wordCount } from "@/shared/transcript";

type Status = { tone: "error" | "success" | "info"; text: string };
type HomeMode = "youtube" | "file";

type ProviderDrafts = Record<CloudProvider, string>;
type ProviderConfigured = Record<CloudProvider, boolean>;

const PROVIDERS: Array<{ id: CloudProvider; title: string; subtitle: string }> = [
  { id: "gemini", title: "Gemini / Google AI Studio", subtitle: "Public YouTube URL + uploaded media fallback" },
  { id: "groq", title: "Groq Whisper", subtitle: "Fast, accurate speech-to-text for audio/video files" },
  { id: "openai", title: "OpenAI Transcribe", subtitle: "High-quality audio/video transcription fallback" },
];

const FILE_MODES: Array<{ id: FileImportMode; title: string; subtitle: string }> = [
  { id: "auto", title: "Auto · Local First", subtitle: "Subtitle → Offline Whisper → cloud only if local fails" },
  { id: "subtitle-only", title: "No Speech AI", subtitle: "Only subtitle/text tracks. No speech model, no cloud." },
  { id: "no-cloud", title: "No Cloud", subtitle: "Subtitle → offline Whisper. Media never sent to cloud." },
  { id: "best-quality", title: "Best Quality", subtitle: "Subtitle first, then configured cloud STT; local fallback if cloud fails." },
];

function fireHaptic(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  if (Platform.OS !== "web") void Haptics.impactAsync(style);
}

function formatDate(value: number): string {
  try {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(value);
  } catch {
    return new Date(value).toLocaleDateString();
  }
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function providerLabel(provider?: TranscriptProvider, source?: TranscriptDocument["source"]): string {
  if (provider === "youtube") return source === "creator" ? "Creator captions" : "YouTube captions";
  if (provider === "subtitle-file") return "Subtitle file";
  if (provider === "embedded-subtitle") return "Embedded subtitles";
  if (provider === "whisper-local") return "Offline Whisper";
  if (provider === "gemini") return "Gemini";
  if (provider === "groq") return "Groq Whisper";
  if (provider === "openai") return "OpenAI Transcribe";
  if (provider === "manual") return "Manual paste";
  if (source === "automatic") return "Automatic captions";
  if (source === "creator") return "Creator captions";
  if (source === "ai") return "Cloud transcription";
  return "Local transcript";
}

function SourceBadge({ document, colors }: { document: TranscriptDocument; colors: ReturnType<typeof useColors> }) {
  const cloud = document.provider === "gemini" || document.provider === "groq" || document.provider === "openai";
  const local = document.provider === "whisper-local" || document.provider === "embedded-subtitle" || document.provider === "subtitle-file" || document.provider === "manual";
  const color = cloud ? colors.warning : local ? colors.success : colors.primary;
  return (
    <View style={[styles.sourceBadge, { backgroundColor: color + "18" }]}>
      <View style={[styles.sourceDot, { backgroundColor: color }]} />
      <Text style={[styles.sourceBadgeText, { color }]}>{providerLabel(document.provider, document.source)}</Text>
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
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + "14" }]}>
        <Text style={[styles.rowIconText, { color: colors.primary }]}>T</Text>
      </View>
      <View style={styles.rowContent}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: colors.foreground }]}>{document.title}</Text>
        <View style={styles.rowMeta}>
          <Text style={[styles.rowMetaText, { color: colors.muted }]}>{providerLabel(document.provider, document.source)}</Text>
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

  useEffect(() => {
    setDraft(document.editedText);
    setMode("read");
    setSearchQuery("");
  }, [document.id, document.editedText]);

  const saveDraft = () => {
    onUpdate({ ...document, editedText: draft, updatedAt: Date.now() });
    setNotice("Changes saved on this device.");
    fireHaptic();
  };

  const copyDraft = async () => {
    await Clipboard.setStringAsync(draft);
    setNotice("Transcript copied to clipboard.");
    fireHaptic();
  };

  const resetDraft = () => {
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
        style={[styles.workspaceShell, { paddingBottom: Math.max(insets.bottom, 12) + 6 }]}
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
            <SourceBadge document={document} colors={colors} />
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
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")} accessibilityRole="button">
              <Text style={[styles.clearSearch, { color: colors.muted }]}>×</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={[styles.modeSwitch, { backgroundColor: colors.surface }]}>
          <TouchableOpacity onPress={() => setMode("read")} style={[styles.modeOption, mode === "read" && { backgroundColor: colors.background }]}>
            <Text style={[styles.modeOptionText, { color: mode === "read" ? colors.foreground : colors.muted }]}>Preview</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setMode("edit")} style={[styles.modeOption, mode === "edit" && { backgroundColor: colors.background }]}>
            <Text style={[styles.modeOptionText, { color: mode === "edit" ? colors.foreground : colors.muted }]}>Edit</Text>
          </TouchableOpacity>
        </View>

        <View style={[styles.transcriptPanel, { borderColor: colors.border, backgroundColor: colors.background }]}>
          {mode === "read" ? (
            <FlatList
              data={displaySegments}
              keyExtractor={(item, index) => `${document.id}-${index}-${item.start}`}
              renderItem={({ item }) => <SegmentPreview segment={item} colors={colors} />}
              contentContainerStyle={styles.segmentList}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
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
            <TouchableOpacity onPress={resetDraft} style={styles.resetButton}>
              <Text style={[styles.resetButtonText, { color: colors.primary }]}>Reset to original</Text>
            </TouchableOpacity>
          )}
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={copyDraft} style={[styles.secondaryAction, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={mode === "edit" ? saveDraft : () => setMode("edit")} style={[styles.primaryAction, { backgroundColor: colors.primary }]}>
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
              <TouchableOpacity onPress={() => setShowExport(false)} style={styles.closeButton}>
                <Text style={[styles.closeButtonText, { color: colors.muted }]}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.sheetBody, { color: colors.muted }]}>Your edited transcript will be packaged as a Word document and opened in the Android share sheet.</Text>
            <TouchableOpacity onPress={() => setIncludeTimestamps((value) => !value)} style={[styles.optionRow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <View style={[styles.checkbox, { borderColor: includeTimestamps ? colors.primary : colors.border, backgroundColor: includeTimestamps ? colors.primary : "transparent" }]}>
                {includeTimestamps && <Text style={styles.checkboxMark}>✓</Text>}
              </View>
              <View style={styles.optionCopy}>
                <Text style={[styles.optionTitle, { color: colors.foreground }]}>Include timestamps</Text>
                <Text style={[styles.optionSubtitle, { color: colors.muted }]}>Add available timestamps to the document</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={runExport} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
              <Text style={styles.primaryButtonText}>Export DOCX</Text>
              <Text style={styles.primaryButtonArrow}>→</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

function StatusCard({ status, colors }: { status: Status | null; colors: ReturnType<typeof useColors> }) {
  if (!status) return null;
  const color = status.tone === "error" ? colors.error : status.tone === "success" ? colors.success : colors.primary;
  return (
    <View style={[styles.statusCard, { backgroundColor: color + "12" }]}>
      <View style={[styles.statusIcon, { backgroundColor: color }]}>
        <Text style={styles.statusIconText}>{status.tone === "error" ? "!" : status.tone === "success" ? "✓" : "i"}</Text>
      </View>
      <Text style={[styles.statusText, { color: colors.foreground }]}>{status.text}</Text>
    </View>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [homeMode, setHomeMode] = useState<HomeMode>("youtube");
  const [sourceUrl, setSourceUrl] = useState("");
  const [language, setLanguage] = useState("");
  const [documents, setDocuments] = useState<TranscriptDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [fileMode, setFileMode] = useState<FileImportMode>("auto");
  const [showSettings, setShowSettings] = useState(false);
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>({ gemini: "", groq: "", openai: "" });
  const [providerConfigured, setProviderConfigured] = useState<ProviderConfigured>({ gemini: false, groq: false, openai: false });
  const [savingProvider, setSavingProvider] = useState<CloudProvider | null>(null);
  const [offlineReady, setOfflineReady] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualText, setManualText] = useState("");

  const selectedDocument = useMemo(() => documents.find((item) => item.id === selectedId) ?? null, [documents, selectedId]);

  const refreshProviderState = async () => {
    const configured = new Set(await getConfiguredProviders());
    setProviderConfigured({
      gemini: configured.has("gemini"),
      groq: configured.has("groq"),
      openai: configured.has("openai"),
    });
    setOfflineReady(isOfflineModelReady());
  };

  useEffect(() => {
    loadDocuments().then(setDocuments);
    void refreshProviderState();
  }, []);

  const saveAndOpen = async (document: TranscriptDocument) => {
    const next = [document, ...documents.filter((item) => item.id !== document.id && (!document.videoId || item.videoId !== document.videoId))].slice(0, 100);
    await persistDocuments(next);
    setDocuments(next);
    setSelectedId(document.id);
  };

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

  const handleYouTubeImport = async () => {
    if (!sourceUrl.trim()) {
      setStatus({ tone: "error", text: "YouTube video link ကို အရင်ထည့်ပါ။" });
      return;
    }
    setBusy(true);
    setStatus(null);
    setStage("YouTube link ကို စစ်နေပါတယ်…");
    try {
      const result = await importDirectTranscript(sourceUrl, language, (nextStage) => {
        setStage(nextStage === "checking"
          ? "YouTube link ကို စစ်နေပါတယ်…"
          : nextStage === "captions"
            ? "Creator / automatic caption tracks ကို အရင်ရှာနေပါတယ်…"
            : "Caption မတွေ့လို့ Gemini direct-video fallback ကို အသုံးပြုနေပါတယ်…");
      });
      const document = importedToDocument(result);
      await saveAndOpen(document);
      setSourceUrl("");
      setStatus({
        tone: "success",
        text: result.provider === "youtube"
          ? "YouTube caption နဲ့ပြီးပါပြီ — cloud AI မသုံးပါ။"
          : "Caption မရှိလို့ Gemini direct-video fallback နဲ့ transcript ထုတ်ပြီးပါပြီ။",
      });
      fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcript မရပါ။";
      setStatus({ tone: "error", text: message });
      if ((error as Error & { code?: string })?.code === "AI_KEY_REQUIRED") setShowSettings(true);
    } finally {
      setBusy(false);
      setStage("");
    }
  };

  const handleFileImport = async () => {
    setBusy(true);
    setStatus(null);
    setStage("File picker ဖွင့်နေပါတယ်…");
    try {
      const file = await pickTranscriptFile();
      const imported = await importMediaFile(file, {
        mode: fileMode,
        language,
        onStage: (_nextStage, detail) => setStage(detail ?? "Processing file…"),
      });
      const document = importedToDocument(imported);
      await saveAndOpen(document);
      setOfflineReady(isOfflineModelReady());
      const provider = providerLabel(document.provider, document.source);
      setStatus({ tone: "success", text: `${provider} နဲ့ transcript ပြီးပါပြီ။` });
      fireHaptic(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      const message = error instanceof Error ? error.message : "File transcript မရပါ။";
      if (!/No file selected/iu.test(message)) setStatus({ tone: "error", text: message });
    } finally {
      setBusy(false);
      setStage("");
    }
  };

  const handleSaveProvider = async (provider: CloudProvider) => {
    const value = providerDrafts[provider].trim();
    if (!value) {
      setStatus({ tone: "error", text: `${provider.toUpperCase()} API key ကို ထည့်ပါ။` });
      return;
    }
    setSavingProvider(provider);
    try {
      await saveProviderKey(provider, value);
      setProviderDrafts((current) => ({ ...current, [provider]: "" }));
      await refreshProviderState();
      setStatus({ tone: "success", text: `${provider.toUpperCase()} key ကို Android SecureStore ထဲသိမ်းပြီးပါပြီ။ လိုအပ်မှသာသုံးပါမယ်။` });
      fireHaptic();
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Key save failed." });
    } finally {
      setSavingProvider(null);
    }
  };

  const handleRemoveProvider = async (provider: CloudProvider) => {
    await saveProviderKey(provider, "");
    await refreshProviderState();
    setStatus({ tone: "info", text: `${provider.toUpperCase()} key ကိုဖယ်ပြီးပါပြီ။` });
  };

  const handleDownloadModel = async () => {
    setModelBusy(true);
    setStatus(null);
    try {
      await ensureOfflineModel((_stage, detail) => setStage(detail ?? "Offline model download…"));
      setOfflineReady(true);
      setStatus({ tone: "success", text: "Offline multilingual Whisper model အဆင်သင့်ဖြစ်ပါပြီ။" });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Offline model download failed." });
    } finally {
      setModelBusy(false);
      setStage("");
    }
  };

  const handleRemoveModel = async () => {
    await removeOfflineModel();
    setOfflineReady(false);
    setStatus({ tone: "info", text: "Offline Whisper model ကို ဖုန်းထဲက ဖယ်ပြီးပါပြီ။" });
  };

  const handlePasteManual = async () => {
    const value = await Clipboard.getStringAsync();
    if (!value.trim()) {
      setStatus({ tone: "info", text: "Clipboard ထဲမှာ transcript text မတွေ့ပါ။" });
      return;
    }
    setManualText(value);
  };

  const handleSaveManual = async () => {
    if (!manualText.trim()) {
      setStatus({ tone: "error", text: "Transcript text ကို အရင်ထည့်ပါ။" });
      return;
    }
    const document = textToDocument(manualText, manualTitle || "Manual transcript", "", language || "unknown");
    await saveAndOpen(document);
    setManualText("");
    setManualTitle("");
    setManualOpen(false);
    setStatus({ tone: "success", text: "Manual transcript ကို local device ထဲသိမ်းပြီးပါပြီ။" });
  };

  const handleUpdateDocument = (updated: TranscriptDocument) => {
    setDocuments((current) => {
      const next = current.map((item) => item.id === updated.id ? updated : item);
      void persistDocuments(next);
      return next;
    });
  };

  if (selectedDocument) {
    return <Workspace document={selectedDocument} onBack={() => setSelectedId(null)} onUpdate={handleUpdateDocument} colors={colors} />;
  }

  const configuredCount = Object.values(providerConfigured).filter(Boolean).length;

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right"]}>
      <FlatList
        data={documents}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <TranscriptRow document={item} onOpen={() => setSelectedId(item.id)} colors={colors} />}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 32 }}
        ListHeaderComponent={(
          <View>
            <View style={styles.topBar}>
              <View style={styles.topBarCopy}>
                <Text style={[styles.eyebrow, { color: colors.primary }]}>YOUTUBE TRANSCRIPT STUDIO · V1.2</Text>
                <Text style={[styles.appTitle, { color: colors.foreground }]}>Local first. AI only when needed.</Text>
              </View>
              <TouchableOpacity onPress={() => setShowSettings(true)} style={[styles.settingsButton, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.settingsButtonText, { color: colors.foreground }]}>⚙</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.heroCard, { backgroundColor: colors.primary }]}>
              <View style={styles.heroOrbLarge} />
              <View style={styles.heroOrbSmall} />
              <Text style={styles.heroKicker}>SOURCE FIRST · LOCAL FIRST · CLOUD LAST</Text>
              <Text style={styles.heroTitle}>Link, subtitle, audio, video — တစ်နေရာတည်း</Text>
              <Text style={styles.heroBody}>Caption/subtitle ရှိရင် AI မသုံးဘူး။ မရှိမှ offline Whisper ကိုသုံးပြီး၊ local မရမှသာ သင်ဖွင့်ထားတဲ့ cloud provider ကို fallback လုပ်မယ်။</Text>
            </View>

            <View style={[styles.homeModeSwitch, { backgroundColor: colors.surface }]}>
              <TouchableOpacity onPress={() => setHomeMode("youtube")} style={[styles.homeModeOption, homeMode === "youtube" && { backgroundColor: colors.background }]}>
                <Text style={[styles.homeModeText, { color: homeMode === "youtube" ? colors.foreground : colors.muted }]}>YouTube Link</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setHomeMode("file")} style={[styles.homeModeOption, homeMode === "file" && { backgroundColor: colors.background }]}>
                <Text style={[styles.homeModeText, { color: homeMode === "file" ? colors.foreground : colors.muted }]}>Audio / Video / Subtitle</Text>
              </TouchableOpacity>
            </View>

            {homeMode === "youtube" ? (
              <View style={[styles.inputCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.inputLabel, { color: colors.foreground }]}>YouTube video</Text>
                <TextInput
                  value={sourceUrl}
                  onChangeText={setSourceUrl}
                  placeholder="https://youtu.be/... or youtube.com/watch?v=..."
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  style={[styles.singleInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                />
                <View style={styles.compactRow}>
                  <TextInput
                    value={language}
                    onChangeText={setLanguage}
                    placeholder="Language hint (optional)"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                    style={[styles.singleInput, styles.languageInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                  />
                  <TouchableOpacity onPress={handlePasteLink} style={[styles.pasteLinkButton, { backgroundColor: colors.primary + "16" }]}>
                    <Text style={[styles.pasteLinkText, { color: colors.primary }]}>Paste link</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity onPress={handleYouTubeImport} disabled={busy} style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && styles.disabledButton]}>
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Get Transcript</Text>}
                  {!busy && <Text style={styles.primaryButtonArrow}>→</Text>}
                </TouchableOpacity>
                <Text style={[styles.inputFootnote, { color: colors.muted }]}>YouTube captions → Gemini direct URL only if captions fail and Gemini is configured.</Text>
              </View>
            ) : (
              <View style={[styles.inputCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.inputLabel, { color: colors.foreground }]}>File processing mode</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fileModeRow}>
                  {FILE_MODES.map((item) => {
                    const active = fileMode === item.id;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        onPress={() => setFileMode(item.id)}
                        style={[styles.fileModeChip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "12" : colors.background }]}
                      >
                        <Text style={[styles.fileModeTitle, { color: active ? colors.primary : colors.foreground }]}>{item.title}</Text>
                        <Text style={[styles.fileModeSubtitle, { color: colors.muted }]}>{item.subtitle}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <TextInput
                  value={language}
                  onChangeText={setLanguage}
                  placeholder="Language hint: my, en, th… (optional)"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  style={[styles.singleInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                />
                <TouchableOpacity onPress={handleFileImport} disabled={busy} style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && styles.disabledButton]}>
                  {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Choose File & Transcribe</Text>}
                  {!busy && <Text style={styles.primaryButtonArrow}>→</Text>}
                </TouchableOpacity>
                <Text style={[styles.inputFootnote, { color: colors.muted }]}>SRT · VTT · ASS · TXT · MP3 · M4A · WAV · MP4 · MKV · WebM and other common media.</Text>
              </View>
            )}

            {(busy || modelBusy) && stage ? <Text style={[styles.progressText, { color: colors.muted }]}>{stage}</Text> : null}

            <TouchableOpacity onPress={() => setShowSettings(true)} activeOpacity={0.78} style={[styles.engineCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <View style={[styles.engineIcon, { backgroundColor: offlineReady ? colors.success + "18" : colors.primary + "14" }]}>
                <Text style={{ color: offlineReady ? colors.success : colors.primary, fontWeight: "900" }}>{offlineReady ? "✓" : "AI"}</Text>
              </View>
              <View style={styles.engineCopy}>
                <Text style={[styles.engineTitle, { color: colors.foreground }]}>Transcription Engine</Text>
                <Text style={[styles.engineSubtitle, { color: colors.muted }]}>{offlineReady ? "Offline Whisper ready" : "Offline model downloads only when needed"} · {configuredCount} cloud provider{configuredCount === 1 ? "" : "s"} configured</Text>
              </View>
              <Text style={[styles.rowChevron, { color: colors.muted }]}>›</Text>
            </TouchableOpacity>

            <StatusCard status={status} colors={colors} />

            <TouchableOpacity onPress={() => setManualOpen((value) => !value)} style={styles.manualToggle}>
              <Text style={[styles.manualToggleText, { color: colors.primary }]}>{manualOpen ? "Hide manual paste" : "Manual paste fallback"}</Text>
              <Text style={[styles.manualToggleArrow, { color: colors.primary }]}>{manualOpen ? "−" : "+"}</Text>
            </TouchableOpacity>

            {manualOpen && (
              <View style={[styles.manualCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <TextInput value={manualTitle} onChangeText={setManualTitle} placeholder="Document title (optional)" placeholderTextColor={colors.muted} style={[styles.singleInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
                <View style={[styles.manualTextWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
                  <TextInput value={manualText} onChangeText={setManualText} placeholder="Paste transcript text here..." placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.manualTextInput, { color: colors.foreground }]} />
                  <TouchableOpacity onPress={handlePasteManual} style={[styles.smallButton, { backgroundColor: colors.primary + "14" }]}>
                    <Text style={[styles.smallButtonText, { color: colors.primary }]}>Paste clipboard</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity onPress={handleSaveManual} style={[styles.secondaryFullButton, { borderColor: colors.border }]}>
                  <Text style={[styles.secondaryFullButtonText, { color: colors.foreground }]}>Save manual transcript</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.sectionHeading}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent transcripts</Text>
              <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>Stored locally on this device</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={(
          <View style={[styles.emptyCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No transcripts yet</Text>
            <Text style={[styles.emptyBody, { color: colors.muted }]}>YouTube link သို့မဟုတ် audio/video/subtitle file တစ်ခုရွေးပြီး စတင်ပါ။</Text>
          </View>
        )}
      />

      <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.settingsSheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 18) + 14 }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.sheetEyebrow, { color: colors.primary }]}>LOCAL-FIRST ENGINE</Text>
                <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Offline & Cloud Providers</Text>
              </View>
              <TouchableOpacity onPress={() => setShowSettings(false)} style={styles.closeButton}>
                <Text style={[styles.closeButtonText, { color: colors.muted }]}>×</Text>
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.settingsScroll} keyboardShouldPersistTaps="handled">
              <View style={[styles.offlineCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <View style={styles.providerHeader}>
                  <View style={[styles.providerDot, { backgroundColor: offlineReady ? colors.success : colors.muted }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.providerTitle, { color: colors.foreground }]}>Offline Whisper · multilingual</Text>
                    <Text style={[styles.providerSubtitle, { color: colors.muted }]}>{offlineReady ? "Installed · media stays on this phone" : "~60 MB one-time model download · no API key"}</Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={offlineReady ? handleRemoveModel : handleDownloadModel}
                  disabled={modelBusy}
                  style={[styles.providerButton, { borderColor: offlineReady ? colors.error + "55" : colors.primary, backgroundColor: offlineReady ? colors.error + "0D" : colors.primary + "10" }]}
                >
                  {modelBusy ? <ActivityIndicator color={colors.primary} /> : <Text style={[styles.providerButtonText, { color: offlineReady ? colors.error : colors.primary }]}>{offlineReady ? "Remove offline model" : "Download offline model"}</Text>}
                </TouchableOpacity>
              </View>

              <Text style={[styles.settingsHint, { color: colors.muted }]}>Cloud keys are optional. They are stored in Android SecureStore and only used by modes that allow cloud fallback. A shared key is never baked into the APK.</Text>

              {PROVIDERS.map((provider) => {
                const configured = providerConfigured[provider.id];
                return (
                  <View key={provider.id} style={[styles.providerCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                    <View style={styles.providerHeader}>
                      <View style={[styles.providerDot, { backgroundColor: configured ? colors.success : colors.muted }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.providerTitle, { color: colors.foreground }]}>{provider.title}</Text>
                        <Text style={[styles.providerSubtitle, { color: colors.muted }]}>{configured ? "Configured securely" : provider.subtitle}</Text>
                      </View>
                    </View>
                    <TextInput
                      value={providerDrafts[provider.id]}
                      onChangeText={(value) => setProviderDrafts((current) => ({ ...current, [provider.id]: value }))}
                      placeholder={configured ? "Enter a new key to replace it" : "Paste API key"}
                      placeholderTextColor={colors.muted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                      style={[styles.keyInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                    />
                    <View style={styles.providerActions}>
                      <TouchableOpacity onPress={() => handleSaveProvider(provider.id)} disabled={savingProvider !== null} style={[styles.providerPrimary, { backgroundColor: colors.primary }]}>
                        {savingProvider === provider.id ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.providerPrimaryText}>{configured ? "Replace key" : "Save key"}</Text>}
                      </TouchableOpacity>
                      {configured && (
                        <TouchableOpacity onPress={() => handleRemoveProvider(provider.id)} disabled={savingProvider !== null} style={[styles.providerRemove, { borderColor: colors.border }]}>
                          <Text style={[styles.providerRemoveText, { color: colors.error }]}>Remove</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  topBar: { paddingTop: 4, paddingBottom: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  topBarCopy: { flex: 1, paddingRight: 12 },
  eyebrow: { fontSize: 9, fontWeight: "900", letterSpacing: 1.35, marginBottom: 5 },
  appTitle: { fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.45 },
  settingsButton: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  settingsButtonText: { fontSize: 19, fontWeight: "900" },
  heroCard: { minHeight: 200, borderRadius: 28, padding: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 14 },
  heroOrbLarge: { position: "absolute", width: 220, height: 220, borderRadius: 110, right: -72, top: -76, backgroundColor: "#FFFFFF18" },
  heroOrbSmall: { position: "absolute", width: 94, height: 94, borderRadius: 47, right: 30, top: 42, backgroundColor: "#FFFFFF10" },
  heroKicker: { color: "#DCEBFF", fontSize: 9, fontWeight: "900", letterSpacing: 1.2, marginBottom: 8 },
  heroTitle: { color: "#FFFFFF", fontSize: 25, fontWeight: "850", lineHeight: 32, maxWidth: 320, marginBottom: 8 },
  heroBody: { color: "#EAF2FF", fontSize: 12, lineHeight: 19, maxWidth: 350 },
  homeModeSwitch: { flexDirection: "row", borderRadius: 15, padding: 4, marginBottom: 12 },
  homeModeOption: { flex: 1, minHeight: 43, alignItems: "center", justifyContent: "center", borderRadius: 12, paddingHorizontal: 6 },
  homeModeText: { fontSize: 11, fontWeight: "850", textAlign: "center" },
  inputCard: { borderWidth: 1, borderRadius: 22, padding: 16, marginBottom: 10 },
  inputLabel: { fontSize: 14, fontWeight: "850", marginBottom: 10 },
  singleInput: { minHeight: 48, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, fontSize: 13, marginBottom: 9 },
  compactRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  languageInput: { flex: 1 },
  pasteLinkButton: { minHeight: 48, borderRadius: 13, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  pasteLinkText: { fontSize: 12, fontWeight: "850" },
  primaryButton: { minHeight: 52, borderRadius: 14, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "850" },
  primaryButtonArrow: { color: "#FFFFFF", fontSize: 20, lineHeight: 20 },
  disabledButton: { opacity: 0.62 },
  inputFootnote: { marginTop: 9, fontSize: 10, lineHeight: 16, fontWeight: "600" },
  fileModeRow: { gap: 8, paddingBottom: 11 },
  fileModeChip: { width: 174, minHeight: 78, borderWidth: 1, borderRadius: 14, padding: 11 },
  fileModeTitle: { fontSize: 12, fontWeight: "850", marginBottom: 4 },
  fileModeSubtitle: { fontSize: 9, lineHeight: 14, fontWeight: "600" },
  progressText: { marginBottom: 10, fontSize: 11, lineHeight: 17, fontWeight: "650", textAlign: "center" },
  engineCard: { borderWidth: 1, borderRadius: 18, padding: 13, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 11 },
  engineIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  engineCopy: { flex: 1 },
  engineTitle: { fontSize: 14, fontWeight: "850" },
  engineSubtitle: { fontSize: 10, lineHeight: 15, marginTop: 3 },
  statusCard: { flexDirection: "row", alignItems: "center", borderRadius: 14, padding: 12, gap: 10, marginBottom: 10 },
  statusIcon: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  statusIconText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  statusText: { flex: 1, fontSize: 11, lineHeight: 18, fontWeight: "650" },
  manualToggle: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, marginBottom: 6 },
  manualToggleText: { fontSize: 12, fontWeight: "850" },
  manualToggleArrow: { fontSize: 20, fontWeight: "700" },
  manualCard: { borderWidth: 1, borderRadius: 18, padding: 13, marginBottom: 12 },
  manualTextWrap: { minHeight: 150, borderWidth: 1, borderRadius: 13, padding: 4, marginBottom: 10 },
  manualTextInput: { flex: 1, minHeight: 100, padding: 10, fontSize: 14, lineHeight: 21 },
  smallButton: { alignSelf: "flex-end", borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, marginRight: 5, marginBottom: 5 },
  smallButtonText: { fontSize: 11, fontWeight: "850" },
  secondaryFullButton: { minHeight: 46, borderWidth: 1, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  secondaryFullButtonText: { fontSize: 13, fontWeight: "850" },
  sectionHeading: { paddingTop: 8, paddingBottom: 9 },
  sectionTitle: { fontSize: 18, fontWeight: "850", letterSpacing: -0.2 },
  sectionSubtitle: { fontSize: 11, marginTop: 3 },
  emptyCard: { borderWidth: 1, borderRadius: 20, padding: 20, alignItems: "center", marginTop: 4 },
  emptyTitle: { fontSize: 16, fontWeight: "850", marginBottom: 5 },
  emptyBody: { fontSize: 11, lineHeight: 18, textAlign: "center", maxWidth: 280 },
  transcriptRow: { minHeight: 82, borderWidth: 1, borderRadius: 18, padding: 13, flexDirection: "row", alignItems: "center", gap: 12 },
  rowIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  rowIconText: { fontSize: 19, fontWeight: "900" },
  rowContent: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, lineHeight: 19, fontWeight: "750" },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 },
  rowMetaText: { fontSize: 9, fontWeight: "650" },
  metaSeparator: { width: 3, height: 3, borderRadius: 2 },
  rowChevron: { fontSize: 26, lineHeight: 26 },
  workspaceShell: { flex: 1 },
  workspaceHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 3, paddingBottom: 13 },
  backButton: { flexDirection: "row", alignItems: "center", paddingVertical: 5, paddingRight: 10 },
  backButtonText: { fontSize: 30, lineHeight: 26, marginRight: 5 },
  backButtonLabel: { fontSize: 13, fontWeight: "850" },
  headerExport: { borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8 },
  headerExportText: { fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  workspaceTitleBlock: { paddingBottom: 12 },
  workspaceEyebrow: { fontSize: 9, fontWeight: "900", letterSpacing: 1.35, marginBottom: 6 },
  workspaceTitle: { fontSize: 22, fontWeight: "850", lineHeight: 28, letterSpacing: -0.35 },
  workspaceMetaLine: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 9, flexWrap: "wrap" },
  workspaceLanguage: { fontSize: 10, fontWeight: "850" },
  sourceBadge: { flexDirection: "row", alignItems: "center", borderRadius: 100, paddingHorizontal: 8, paddingVertical: 4, gap: 5 },
  sourceDot: { width: 6, height: 6, borderRadius: 3 },
  sourceBadgeText: { fontSize: 9, fontWeight: "850" },
  searchWrap: { minHeight: 44, borderWidth: 1, borderRadius: 13, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", marginBottom: 10 },
  searchMark: { fontSize: 20, width: 23, textAlign: "center" },
  searchInput: { flex: 1, minHeight: 40, paddingHorizontal: 7, fontSize: 12 },
  clearSearch: { fontSize: 22, paddingHorizontal: 4, lineHeight: 22 },
  modeSwitch: { flexDirection: "row", borderRadius: 12, padding: 3, marginBottom: 10 },
  modeOption: { flex: 1, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  modeOptionText: { fontSize: 12, fontWeight: "850" },
  transcriptPanel: { flex: 1, borderWidth: 1, borderRadius: 18, overflow: "hidden", minHeight: 240 },
  segmentList: { paddingHorizontal: 15, paddingVertical: 14, paddingBottom: 30 },
  segmentRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8 },
  segmentTime: { width: 48, fontSize: 9, fontWeight: "850", paddingTop: 3 },
  segmentText: { flex: 1, fontSize: 15, lineHeight: 24 },
  editor: { flex: 1, fontSize: 15, lineHeight: 24, padding: 15, minHeight: 240 },
  workspaceBottom: { paddingTop: 9 },
  countLine: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  countText: { fontSize: 9, fontWeight: "700" },
  inlineNotice: { fontSize: 10, fontWeight: "700", marginBottom: 6 },
  resetButton: { alignSelf: "flex-start", paddingVertical: 4, marginBottom: 6 },
  resetButtonText: { fontSize: 10, fontWeight: "850" },
  actionRow: { flexDirection: "row", gap: 9 },
  secondaryAction: { flex: 0.75, minHeight: 48, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  secondaryActionText: { fontSize: 13, fontWeight: "850" },
  primaryAction: { flex: 1.25, minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  primaryActionText: { color: "#FFFFFF", fontSize: 13, fontWeight: "850" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#10182888" },
  exportSheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20 },
  settingsSheet: { maxHeight: "90%", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 18, paddingTop: 12 },
  sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: "#D0D5DD", alignSelf: "center", marginBottom: 18 },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  sheetEyebrow: { fontSize: 9, fontWeight: "900", letterSpacing: 1.35, marginBottom: 6 },
  sheetTitle: { fontSize: 22, fontWeight: "850" },
  closeButton: { padding: 3, marginLeft: 8 },
  closeButtonText: { fontSize: 28, lineHeight: 24 },
  sheetBody: { fontSize: 12, lineHeight: 20, marginTop: 11, marginBottom: 16 },
  optionRow: { borderWidth: 1, borderRadius: 15, padding: 12, flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 17 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  checkboxMark: { color: "#FFFFFF", fontSize: 14, fontWeight: "900" },
  optionCopy: { flex: 1 },
  optionTitle: { fontSize: 13, fontWeight: "850" },
  optionSubtitle: { fontSize: 10, marginTop: 3 },
  settingsScroll: { paddingTop: 16, paddingBottom: 16, gap: 10 },
  settingsHint: { fontSize: 10, lineHeight: 16, marginVertical: 2 },
  offlineCard: { borderWidth: 1, borderRadius: 18, padding: 13 },
  providerCard: { borderWidth: 1, borderRadius: 18, padding: 13 },
  providerHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 11 },
  providerDot: { width: 9, height: 9, borderRadius: 5 },
  providerTitle: { fontSize: 13, fontWeight: "850" },
  providerSubtitle: { fontSize: 9, lineHeight: 14, marginTop: 2 },
  keyInput: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, marginBottom: 9, fontSize: 12 },
  providerActions: { flexDirection: "row", gap: 8 },
  providerPrimary: { flex: 1, minHeight: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  providerPrimaryText: { color: "#FFFFFF", fontSize: 11, fontWeight: "850" },
  providerRemove: { minWidth: 86, minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  providerRemoveText: { fontSize: 11, fontWeight: "850" },
  providerButton: { minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  providerButtonText: { fontSize: 11, fontWeight: "850" },
});
