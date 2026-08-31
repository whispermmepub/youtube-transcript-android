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
import { getConfiguredProviders, saveProviderKey, type CloudProvider } from "@/lib/ai-providers";
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
type ProviderFlags = Record<CloudProvider, boolean>;
type ProviderDrafts = Record<CloudProvider, string>;

const PROVIDERS: Array<{ id: CloudProvider; title: string; note: string }> = [
  { id: "gemini", title: "Gemini / AI Studio", note: "Public YouTube URL + media fallback" },
  { id: "groq", title: "Groq Whisper", note: "Fast speech-to-text for local media" },
  { id: "openai", title: "OpenAI Transcribe", note: "High-quality speech-to-text fallback" },
];

const FILE_MODES: Array<{ id: FileImportMode; title: string; note: string }> = [
  { id: "auto", title: "Auto · Local First", note: "Subtitle → offline → cloud only if needed" },
  { id: "subtitle-only", title: "No Speech AI", note: "Subtitle/text only. No speech model." },
  { id: "no-cloud", title: "No Cloud", note: "Subtitle → offline Whisper only" },
  { id: "best-quality", title: "Best Quality", note: "Subtitle → cloud STT → local fallback" },
];

function haptic(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  if (Platform.OS !== "web") void Haptics.impactAsync(style);
}

function timeLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function dateLabel(value: number): string {
  try {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(value);
  } catch {
    return new Date(value).toLocaleDateString();
  }
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
  return source === "ai" ? "Cloud transcription" : "Local transcript";
}

function ProviderBadge({ document, colors }: { document: TranscriptDocument; colors: ReturnType<typeof useColors> }) {
  const cloud = ["gemini", "groq", "openai"].includes(document.provider ?? "");
  const color = cloud ? colors.warning : document.provider === "youtube" ? colors.primary : colors.success;
  return (
    <View style={[styles.badge, { backgroundColor: color + "18" }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{providerLabel(document.provider, document.source)}</Text>
    </View>
  );
}

function StatusCard({ status, colors }: { status: Status | null; colors: ReturnType<typeof useColors> }) {
  if (!status) return null;
  const color = status.tone === "error" ? colors.error : status.tone === "success" ? colors.success : colors.primary;
  return (
    <View style={[styles.status, { backgroundColor: color + "12" }]}>
      <View style={[styles.statusMark, { backgroundColor: color }]}>
        <Text style={styles.statusMarkText}>{status.tone === "error" ? "!" : status.tone === "success" ? "✓" : "i"}</Text>
      </View>
      <Text style={[styles.statusText, { color: colors.foreground }]}>{status.text}</Text>
    </View>
  );
}

function TranscriptRow({ item, onPress, colors }: { item: TranscriptDocument; onPress: () => void; colors: ReturnType<typeof useColors> }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.78} style={[styles.row, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={[styles.rowIcon, { backgroundColor: colors.primary + "15" }]}><Text style={[styles.rowIconText, { color: colors.primary }]}>T</Text></View>
      <View style={styles.rowBody}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: colors.foreground }]}>{item.title}</Text>
        <Text style={[styles.rowMeta, { color: colors.muted }]}>{providerLabel(item.provider, item.source)} · {dateLabel(item.updatedAt)}</Text>
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
    </TouchableOpacity>
  );
}

function TranscriptSegmentRow({ item, colors }: { item: TranscriptSegment; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={styles.segmentRow}>
      <Text style={[styles.segmentTime, { color: colors.primary }]}>{timeLabel(item.start)}</Text>
      <Text style={[styles.segmentText, { color: colors.foreground }]}>{item.text}</Text>
    </View>
  );
}

function Workspace({ document, colors, onBack, onUpdate }: {
  document: TranscriptDocument;
  colors: ReturnType<typeof useColors>;
  onBack: () => void;
  onUpdate: (document: TranscriptDocument) => void;
}) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState(document.editedText);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [timestamps, setTimestamps] = useState(false);

  useEffect(() => {
    setDraft(document.editedText);
    setMode("preview");
    setQuery("");
  }, [document.id, document.editedText]);

  const segments = useMemo(() => {
    const base = draft === document.originalText && document.segments.length
      ? document.segments
      : draft.split(/\r?\n/u).filter(Boolean).map((text, index) => ({ text, start: index, duration: 0 }));
    const q = query.trim().toLocaleLowerCase();
    return q ? base.filter((segment) => segment.text.toLocaleLowerCase().includes(q)) : base;
  }, [document.originalText, document.segments, draft, query]);

  const save = () => {
    onUpdate({ ...document, editedText: draft, updatedAt: Date.now() });
    setNotice("Saved locally.");
    haptic();
  };

  const copy = async () => {
    await Clipboard.setStringAsync(draft);
    setNotice("Copied to clipboard.");
    haptic();
  };

  const doExport = async () => {
    try {
      await exportDocx({ ...document, editedText: draft }, timestamps);
      setShowExport(false);
      setNotice("DOCX is ready to save/share.");
    } catch {
      setNotice("DOCX export failed.");
    }
  };

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView style={[styles.workspace, { paddingBottom: Math.max(insets.bottom, 10) + 4 }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.workspaceTop}>
          <TouchableOpacity onPress={onBack} style={styles.back}><Text style={[styles.backText, { color: colors.primary }]}>‹ Library</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setShowExport(true)} style={[styles.docxButton, { backgroundColor: colors.primary + "14" }]}><Text style={[styles.docxText, { color: colors.primary }]}>DOCX</Text></TouchableOpacity>
        </View>
        <Text style={[styles.kicker, { color: colors.primary }]}>TRANSCRIPT</Text>
        <Text style={[styles.workspaceTitle, { color: colors.foreground }]}>{document.title}</Text>
        <View style={styles.metaLine}>
          <Text style={[styles.metaText, { color: colors.muted }]}>{formatSourceLanguage(document.language)}</Text>
          <ProviderBadge document={document} colors={colors} />
        </View>

        <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextInput value={query} onChangeText={setQuery} placeholder="Search transcript" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} />
          {!!query && <TouchableOpacity onPress={() => setQuery("")}><Text style={[styles.clear, { color: colors.muted }]}>×</Text></TouchableOpacity>}
        </View>

        <View style={[styles.switch, { backgroundColor: colors.surface }]}>
          {(["preview", "edit"] as const).map((value) => (
            <TouchableOpacity key={value} onPress={() => setMode(value)} style={[styles.switchItem, mode === value && { backgroundColor: colors.background }]}>
              <Text style={[styles.switchText, { color: mode === value ? colors.foreground : colors.muted }]}>{value === "preview" ? "Preview" : "Edit"}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.background }]}>
          {mode === "preview" ? (
            <FlatList data={segments} keyExtractor={(item, index) => `${item.start}-${index}`} renderItem={({ item }) => <TranscriptSegmentRow item={item} colors={colors} />} contentContainerStyle={styles.segmentList} showsVerticalScrollIndicator={false} />
          ) : (
            <TextInput value={draft} onChangeText={setDraft} multiline textAlignVertical="top" placeholder="Edit transcript…" placeholderTextColor={colors.muted} style={[styles.editor, { color: colors.foreground }]} />
          )}
        </View>

        <View style={styles.workspaceFooter}>
          <View style={styles.counts}>
            <Text style={[styles.tiny, { color: colors.muted }]}>{wordCount(draft).toLocaleString()} words</Text>
            <Text style={[styles.tiny, { color: colors.muted }]}>{draft.length.toLocaleString()} characters</Text>
          </View>
          {!!notice && <Text style={[styles.notice, { color: colors.success }]}>{notice}</Text>}
          {draft !== document.originalText && <TouchableOpacity onPress={() => setDraft(document.originalText)}><Text style={[styles.reset, { color: colors.primary }]}>Reset to original</Text></TouchableOpacity>}
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={copy} style={[styles.secondary, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.secondaryText, { color: colors.foreground }]}>Copy</Text></TouchableOpacity>
            <TouchableOpacity onPress={mode === "edit" ? save : () => setMode("edit")} style={[styles.primary, { backgroundColor: colors.primary }]}><Text style={styles.primaryText}>{mode === "edit" ? "Save edits" : "Edit transcript"}</Text></TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={showExport} transparent animationType="slide" onRequestClose={() => setShowExport(false)}>
        <View style={styles.backdrop}>
          <View style={[styles.sheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 18) + 16 }]}>
            <View style={styles.handle} />
            <View style={styles.sheetTop}><Text style={[styles.sheetTitle, { color: colors.foreground }]}>Export DOCX</Text><TouchableOpacity onPress={() => setShowExport(false)}><Text style={[styles.close, { color: colors.muted }]}>×</Text></TouchableOpacity></View>
            <TouchableOpacity onPress={() => setTimestamps((value) => !value)} style={[styles.option, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.checkbox, { borderColor: timestamps ? colors.primary : colors.border, backgroundColor: timestamps ? colors.primary : "transparent" }]}>{timestamps && <Text style={styles.check}>✓</Text>}</View>
              <View><Text style={[styles.optionTitle, { color: colors.foreground }]}>Include timestamps</Text><Text style={[styles.optionNote, { color: colors.muted }]}>Use timestamps when available</Text></View>
            </TouchableOpacity>
            <TouchableOpacity onPress={doExport} style={[styles.bigButton, { backgroundColor: colors.primary }]}><Text style={styles.bigButtonText}>Export & Share</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [documents, setDocuments] = useState<TranscriptDocument[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [homeMode, setHomeMode] = useState<HomeMode>("youtube");
  const [sourceUrl, setSourceUrl] = useState("");
  const [language, setLanguage] = useState("");
  const [fileMode, setFileMode] = useState<FileImportMode>("auto");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [settings, setSettings] = useState(false);
  const [configured, setConfigured] = useState<ProviderFlags>({ gemini: false, groq: false, openai: false });
  const [drafts, setDrafts] = useState<ProviderDrafts>({ gemini: "", groq: "", openai: "" });
  const [saving, setSaving] = useState<CloudProvider | null>(null);
  const [offlineReady, setOfflineReady] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualText, setManualText] = useState("");

  const selectedDocument = useMemo(() => documents.find((item) => item.id === selected) ?? null, [documents, selected]);

  const refreshEngine = async () => {
    const enabled = new Set(await getConfiguredProviders());
    setConfigured({ gemini: enabled.has("gemini"), groq: enabled.has("groq"), openai: enabled.has("openai") });
    setOfflineReady(isOfflineModelReady());
  };

  useEffect(() => {
    void loadDocuments().then(setDocuments);
    void refreshEngine();
  }, []);

  const storeAndOpen = async (document: TranscriptDocument) => {
    const next = [document, ...documents.filter((item) => item.id !== document.id && item.videoId !== document.videoId)].slice(0, 100);
    await persistDocuments(next);
    setDocuments(next);
    setSelected(document.id);
  };

  const pasteLink = async () => {
    const value = (await Clipboard.getStringAsync()).trim();
    if (!value) return setStatus({ tone: "info", text: "Clipboard ထဲမှာ link မတွေ့ပါ။" });
    setSourceUrl(value);
    setStatus(null);
    haptic();
  };

  const importYouTube = async () => {
    if (!sourceUrl.trim()) return setStatus({ tone: "error", text: "YouTube video link ကို အရင်ထည့်ပါ။" });
    setBusy(true); setStatus(null); setStage("YouTube link ကို စစ်နေပါတယ်…");
    try {
      const result = await importDirectTranscript(sourceUrl, language, (next) => setStage(next === "checking" ? "YouTube link ကို စစ်နေပါတယ်…" : next === "captions" ? "Caption tracks ကို AI မသုံးဘဲ ရှာနေပါတယ်…" : "Caption မရလို့ Gemini direct-video fallback ကိုသုံးနေပါတယ်…"));
      await storeAndOpen(importedToDocument(result));
      setSourceUrl("");
      setStatus({ tone: "success", text: result.provider === "youtube" ? "YouTube caption နဲ့ပြီးပါပြီ — cloud AI မသုံးပါ။" : "Gemini fallback နဲ့ transcript ပြီးပါပြီ။" });
      haptic(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Transcript မရပါ။" });
      if ((error as Error & { code?: string })?.code === "AI_KEY_REQUIRED") setSettings(true);
    } finally { setBusy(false); setStage(""); }
  };

  const importFile = async () => {
    setBusy(true); setStatus(null); setStage("File picker ဖွင့်နေပါတယ်…");
    try {
      const file = await pickTranscriptFile();
      const result = await importMediaFile(file, { mode: fileMode, language, onStage: (_s, detail) => setStage(detail ?? "Processing…") });
      const document = importedToDocument(result);
      await storeAndOpen(document);
      setOfflineReady(isOfflineModelReady());
      setStatus({ tone: "success", text: `${providerLabel(document.provider, document.source)} နဲ့ transcript ပြီးပါပြီ။` });
      haptic(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      const message = error instanceof Error ? error.message : "File transcript မရပါ။";
      if (!/No file selected/iu.test(message)) setStatus({ tone: "error", text: message });
    } finally { setBusy(false); setStage(""); }
  };

  const saveKey = async (provider: CloudProvider) => {
    const value = drafts[provider].trim();
    if (!value) return setStatus({ tone: "error", text: `${provider.toUpperCase()} API key ကို ထည့်ပါ။` });
    setSaving(provider);
    try {
      await saveProviderKey(provider, value);
      setDrafts((old) => ({ ...old, [provider]: "" }));
      await refreshEngine();
      setStatus({ tone: "success", text: `${provider.toUpperCase()} key ကို SecureStore ထဲသိမ်းပြီးပါပြီ။ လိုမှသာသုံးပါမယ်။` });
    } finally { setSaving(null); }
  };

  const removeKey = async (provider: CloudProvider) => {
    await saveProviderKey(provider, "");
    await refreshEngine();
    setStatus({ tone: "info", text: `${provider.toUpperCase()} key ဖယ်ပြီးပါပြီ။` });
  };

  const downloadModel = async () => {
    setModelBusy(true); setStatus(null);
    try {
      await ensureOfflineModel((_s, detail) => setStage(detail ?? "Downloading offline model…"));
      setOfflineReady(true);
      setStatus({ tone: "success", text: "Offline multilingual Whisper model အဆင်သင့်ဖြစ်ပါပြီ။" });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Offline model download failed." });
    } finally { setModelBusy(false); setStage(""); }
  };

  const removeModel = async () => {
    await removeOfflineModel();
    setOfflineReady(false);
    setStatus({ tone: "info", text: "Offline Whisper model ဖယ်ပြီးပါပြီ။" });
  };

  const saveManual = async () => {
    if (!manualText.trim()) return setStatus({ tone: "error", text: "Transcript text ကို အရင်ထည့်ပါ။" });
    await storeAndOpen(textToDocument(manualText, manualTitle || "Manual transcript", "", language || "unknown"));
    setManualText(""); setManualTitle(""); setManualOpen(false);
  };

  const updateDocument = (document: TranscriptDocument) => {
    setDocuments((old) => {
      const next = old.map((item) => item.id === document.id ? document : item);
      void persistDocuments(next);
      return next;
    });
  };

  if (selectedDocument) return <Workspace document={selectedDocument} colors={colors} onBack={() => setSelected(null)} onUpdate={updateDocument} />;

  const providerCount = Object.values(configured).filter(Boolean).length;

  return (
    <ScreenContainer className="px-5" edges={["top", "left", "right"]}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 28 }}>
        <View style={styles.topBar}>
          <View style={styles.topCopy}><Text style={[styles.kicker, { color: colors.primary }]}>TRANSCRIPT STUDIO · V1.2</Text><Text style={[styles.title, { color: colors.foreground }]}>Local first. AI only when needed.</Text></View>
          <TouchableOpacity onPress={() => setSettings(true)} style={[styles.settingsButton, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.settingsIcon, { color: colors.foreground }]}>⚙</Text></TouchableOpacity>
        </View>

        <View style={[styles.hero, { backgroundColor: colors.primary }]}>
          <View style={styles.heroCircle} />
          <Text style={styles.heroKicker}>SOURCE FIRST · LOCAL FIRST · CLOUD LAST</Text>
          <Text style={styles.heroTitle}>Link, subtitle, audio, video — တစ်နေရာတည်း</Text>
          <Text style={styles.heroText}>Caption/subtitle ရှိရင် AI မသုံးဘူး။ မရှိမှ offline speech model; local မရမှသာ သင်ဖွင့်ထားတဲ့ cloud provider ကို fallback လုပ်မယ်။</Text>
        </View>

        <View style={[styles.switch, { backgroundColor: colors.surface }]}>
          <TouchableOpacity onPress={() => setHomeMode("youtube")} style={[styles.switchItem, homeMode === "youtube" && { backgroundColor: colors.background }]}><Text style={[styles.switchText, { color: homeMode === "youtube" ? colors.foreground : colors.muted }]}>YouTube Link</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setHomeMode("file")} style={[styles.switchItem, homeMode === "file" && { backgroundColor: colors.background }]}><Text style={[styles.switchText, { color: homeMode === "file" ? colors.foreground : colors.muted }]}>Audio / Video / Subtitle</Text></TouchableOpacity>
        </View>

        {homeMode === "youtube" ? (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>YouTube video</Text>
            <TextInput value={sourceUrl} onChangeText={setSourceUrl} placeholder="https://youtu.be/..." placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
            <View style={styles.inputRow}>
              <TextInput value={language} onChangeText={setLanguage} placeholder="Language hint (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" style={[styles.input, styles.flexInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
              <TouchableOpacity onPress={pasteLink} style={[styles.paste, { backgroundColor: colors.primary + "16" }]}><Text style={[styles.pasteText, { color: colors.primary }]}>Paste link</Text></TouchableOpacity>
            </View>
            <TouchableOpacity onPress={importYouTube} disabled={busy} style={[styles.bigButton, { backgroundColor: colors.primary }, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.bigButtonText}>Get Transcript →</Text>}</TouchableOpacity>
            <Text style={[styles.footnote, { color: colors.muted }]}>YouTube captions first. Gemini direct URL is used only when captions fail and a Gemini key exists.</Text>
          </View>
        ) : (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>File processing mode</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeRow}>
              {FILE_MODES.map((item) => {
                const active = fileMode === item.id;
                return <TouchableOpacity key={item.id} onPress={() => setFileMode(item.id)} style={[styles.modeChip, { backgroundColor: active ? colors.primary + "12" : colors.background, borderColor: active ? colors.primary : colors.border }]}><Text style={[styles.modeTitle, { color: active ? colors.primary : colors.foreground }]}>{item.title}</Text><Text style={[styles.modeNote, { color: colors.muted }]}>{item.note}</Text></TouchableOpacity>;
              })}
            </ScrollView>
            <TextInput value={language} onChangeText={setLanguage} placeholder="Language hint: my, en, th… (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} />
            <TouchableOpacity onPress={importFile} disabled={busy} style={[styles.bigButton, { backgroundColor: colors.primary }, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.bigButtonText}>Choose File & Transcribe →</Text>}</TouchableOpacity>
            <Text style={[styles.footnote, { color: colors.muted }]}>SRT · VTT · ASS · TXT · MP3 · M4A · WAV · MP4 · MKV · WebM and common media.</Text>
          </View>
        )}

        {(busy || modelBusy) && !!stage && <Text style={[styles.progress, { color: colors.muted }]}>{stage}</Text>}

        <TouchableOpacity onPress={() => setSettings(true)} style={[styles.engine, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.engineMark, { backgroundColor: offlineReady ? colors.success + "18" : colors.primary + "14" }]}><Text style={{ color: offlineReady ? colors.success : colors.primary, fontWeight: "900" }}>{offlineReady ? "✓" : "AI"}</Text></View>
          <View style={styles.engineBody}><Text style={[styles.engineTitle, { color: colors.foreground }]}>Transcription Engine</Text><Text style={[styles.engineNote, { color: colors.muted }]}>{offlineReady ? "Offline Whisper ready" : "Offline model installs only when needed"} · {providerCount} cloud provider{providerCount === 1 ? "" : "s"}</Text></View><Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
        </TouchableOpacity>

        <StatusCard status={status} colors={colors} />

        <TouchableOpacity onPress={() => setManualOpen((value) => !value)} style={styles.manualToggle}><Text style={[styles.manualText, { color: colors.primary }]}>{manualOpen ? "Hide manual paste" : "Manual paste fallback"}</Text><Text style={[styles.manualPlus, { color: colors.primary }]}>{manualOpen ? "−" : "+"}</Text></TouchableOpacity>
        {manualOpen && <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><TextInput value={manualTitle} onChangeText={setManualTitle} placeholder="Document title" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} /><TextInput value={manualText} onChangeText={setManualText} multiline textAlignVertical="top" placeholder="Paste transcript text…" placeholderTextColor={colors.muted} style={[styles.manualInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} /><View style={styles.actionRow}><TouchableOpacity onPress={async () => setManualText(await Clipboard.getStringAsync())} style={[styles.secondary, { borderColor: colors.border }]}><Text style={[styles.secondaryText, { color: colors.foreground }]}>Paste</Text></TouchableOpacity><TouchableOpacity onPress={saveManual} style={[styles.primary, { backgroundColor: colors.primary }]}><Text style={styles.primaryText}>Save transcript</Text></TouchableOpacity></View></View>}

        <View style={styles.section}><Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent transcripts</Text><Text style={[styles.sectionNote, { color: colors.muted }]}>Stored locally on this device</Text></View>
        {documents.length ? documents.map((item) => <View key={item.id} style={{ marginBottom: 10 }}><TranscriptRow item={item} onPress={() => setSelected(item.id)} colors={colors} /></View>) : <View style={[styles.empty, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.emptyTitle, { color: colors.foreground }]}>No transcripts yet</Text><Text style={[styles.emptyText, { color: colors.muted }]}>YouTube link သို့မဟုတ် audio/video/subtitle file တစ်ခုနဲ့ စတင်ပါ။</Text></View>}
      </ScrollView>

      <Modal visible={settings} transparent animationType="slide" onRequestClose={() => setSettings(false)}>
        <View style={styles.backdrop}>
          <View style={[styles.settingsSheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 16) + 12 }]}>
            <View style={styles.handle} />
            <View style={styles.sheetTop}><View style={{ flex: 1 }}><Text style={[styles.kicker, { color: colors.primary }]}>LOCAL-FIRST ENGINE</Text><Text style={[styles.sheetTitle, { color: colors.foreground }]}>Offline & Cloud Providers</Text></View><TouchableOpacity onPress={() => setSettings(false)}><Text style={[styles.close, { color: colors.muted }]}>×</Text></TouchableOpacity></View>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.settingsScroll}>
              <View style={[styles.providerCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.providerTop}><View style={[styles.dot, { backgroundColor: offlineReady ? colors.success : colors.muted }]} /><View style={{ flex: 1 }}><Text style={[styles.providerTitle, { color: colors.foreground }]}>Offline Whisper · Multilingual</Text><Text style={[styles.providerNote, { color: colors.muted }]}>{offlineReady ? "Installed · media stays on this phone" : "~60 MB one-time model · no API key"}</Text></View></View>
                <TouchableOpacity onPress={offlineReady ? removeModel : downloadModel} disabled={modelBusy} style={[styles.outlineButton, { borderColor: offlineReady ? colors.error : colors.primary }]}>{modelBusy ? <ActivityIndicator color={colors.primary} /> : <Text style={[styles.outlineText, { color: offlineReady ? colors.error : colors.primary }]}>{offlineReady ? "Remove offline model" : "Download offline model"}</Text>}</TouchableOpacity>
              </View>

              <Text style={[styles.settingsHint, { color: colors.muted }]}>Cloud keys are optional. Keys are stored in Android SecureStore; no shared secret is embedded in the APK.</Text>

              {PROVIDERS.map((provider) => <View key={provider.id} style={[styles.providerCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.providerTop}><View style={[styles.dot, { backgroundColor: configured[provider.id] ? colors.success : colors.muted }]} /><View style={{ flex: 1 }}><Text style={[styles.providerTitle, { color: colors.foreground }]}>{provider.title}</Text><Text style={[styles.providerNote, { color: colors.muted }]}>{configured[provider.id] ? "Configured securely" : provider.note}</Text></View></View><TextInput value={drafts[provider.id]} onChangeText={(value) => setDrafts((old) => ({ ...old, [provider.id]: value }))} placeholder={configured[provider.id] ? "Enter new key to replace" : "Paste API key"} placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]} /><View style={styles.actionRow}><TouchableOpacity onPress={() => saveKey(provider.id)} disabled={saving !== null} style={[styles.primary, { backgroundColor: colors.primary }]}>{saving === provider.id ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{configured[provider.id] ? "Replace key" : "Save key"}</Text>}</TouchableOpacity>{configured[provider.id] && <TouchableOpacity onPress={() => removeKey(provider.id)} style={[styles.secondary, { borderColor: colors.border }]}><Text style={[styles.secondaryText, { color: colors.error }]}>Remove</Text></TouchableOpacity>}</View></View>)}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: "row", alignItems: "center", paddingTop: 4, paddingBottom: 16 },
  topCopy: { flex: 1, paddingRight: 12 },
  kicker: { fontSize: 9, fontWeight: "900", letterSpacing: 1.35, marginBottom: 5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.4 },
  settingsButton: { width: 44, height: 44, borderRadius: 15, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  settingsIcon: { fontSize: 19, fontWeight: "900" },
  hero: { minHeight: 195, borderRadius: 28, padding: 22, justifyContent: "flex-end", overflow: "hidden", marginBottom: 14 },
  heroCircle: { position: "absolute", width: 220, height: 220, borderRadius: 110, right: -70, top: -80, backgroundColor: "#FFFFFF18" },
  heroKicker: { color: "#DCEBFF", fontSize: 9, fontWeight: "900", letterSpacing: 1.15, marginBottom: 8 },
  heroTitle: { color: "#FFFFFF", fontSize: 25, lineHeight: 32, fontWeight: "800", marginBottom: 8, maxWidth: 330 },
  heroText: { color: "#EAF2FF", fontSize: 12, lineHeight: 19, maxWidth: 350 },
  switch: { flexDirection: "row", borderRadius: 14, padding: 4, marginBottom: 12 },
  switchItem: { flex: 1, minHeight: 42, borderRadius: 11, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  switchText: { fontSize: 11, fontWeight: "800", textTransform: "capitalize", textAlign: "center" },
  card: { borderWidth: 1, borderRadius: 21, padding: 15, marginBottom: 10 },
  cardTitle: { fontSize: 14, fontWeight: "800", marginBottom: 10 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 13, paddingHorizontal: 12, fontSize: 12, marginBottom: 9 },
  inputRow: { flexDirection: "row", gap: 8 },
  flexInput: { flex: 1 },
  paste: { minHeight: 48, borderRadius: 13, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  pasteText: { fontSize: 11, fontWeight: "800" },
  bigButton: { minHeight: 51, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  bigButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  disabled: { opacity: 0.6 },
  footnote: { fontSize: 9, lineHeight: 15, marginTop: 9, fontWeight: "600" },
  modeRow: { gap: 8, paddingBottom: 10 },
  modeChip: { width: 172, minHeight: 74, borderWidth: 1, borderRadius: 14, padding: 10 },
  modeTitle: { fontSize: 11, fontWeight: "800", marginBottom: 4 },
  modeNote: { fontSize: 9, lineHeight: 14, fontWeight: "600" },
  progress: { fontSize: 10, lineHeight: 16, textAlign: "center", marginBottom: 10, fontWeight: "600" },
  engine: { borderWidth: 1, borderRadius: 18, padding: 12, flexDirection: "row", alignItems: "center", gap: 11, marginBottom: 10 },
  engineMark: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  engineBody: { flex: 1 },
  engineTitle: { fontSize: 13, fontWeight: "800" },
  engineNote: { fontSize: 9, lineHeight: 14, marginTop: 3 },
  status: { flexDirection: "row", gap: 9, alignItems: "center", padding: 11, borderRadius: 14, marginBottom: 9 },
  statusMark: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  statusMarkText: { color: "#FFFFFF", fontSize: 12, fontWeight: "900" },
  statusText: { flex: 1, fontSize: 10, lineHeight: 17, fontWeight: "600" },
  manualToggle: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 },
  manualText: { fontSize: 11, fontWeight: "800" },
  manualPlus: { fontSize: 20, fontWeight: "700" },
  manualInput: { minHeight: 150, borderWidth: 1, borderRadius: 13, padding: 12, fontSize: 13, lineHeight: 21, marginBottom: 9 },
  section: { paddingTop: 10, paddingBottom: 9 },
  sectionTitle: { fontSize: 18, fontWeight: "800" },
  sectionNote: { fontSize: 10, marginTop: 3 },
  empty: { borderWidth: 1, borderRadius: 18, padding: 20, alignItems: "center" },
  emptyTitle: { fontSize: 15, fontWeight: "800", marginBottom: 5 },
  emptyText: { fontSize: 10, lineHeight: 17, textAlign: "center" },
  row: { minHeight: 78, borderWidth: 1, borderRadius: 17, padding: 12, flexDirection: "row", alignItems: "center", gap: 11 },
  rowIcon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  rowIconText: { fontSize: 18, fontWeight: "900" },
  rowBody: { flex: 1 },
  rowTitle: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  rowMeta: { fontSize: 9, marginTop: 5, fontWeight: "600" },
  chevron: { fontSize: 25 },
  badge: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 9, fontWeight: "800" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  workspace: { flex: 1 },
  workspaceTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 3, paddingBottom: 12 },
  back: { paddingVertical: 6, paddingRight: 10 },
  backText: { fontSize: 13, fontWeight: "800" },
  docxButton: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10 },
  docxText: { fontSize: 10, fontWeight: "900" },
  workspaceTitle: { fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.35 },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 8, paddingBottom: 11 },
  metaText: { fontSize: 10, fontWeight: "800" },
  search: { minHeight: 43, borderWidth: 1, borderRadius: 13, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, marginBottom: 9 },
  searchInput: { flex: 1, minHeight: 40, fontSize: 12 },
  clear: { fontSize: 22, paddingHorizontal: 4 },
  panel: { flex: 1, minHeight: 230, borderWidth: 1, borderRadius: 17, overflow: "hidden" },
  segmentList: { padding: 14, paddingBottom: 26 },
  segmentRow: { flexDirection: "row", gap: 9, alignItems: "flex-start", paddingVertical: 7 },
  segmentTime: { width: 48, fontSize: 9, fontWeight: "800", paddingTop: 3 },
  segmentText: { flex: 1, fontSize: 15, lineHeight: 24 },
  editor: { flex: 1, minHeight: 230, padding: 14, fontSize: 15, lineHeight: 24 },
  workspaceFooter: { paddingTop: 8 },
  counts: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  tiny: { fontSize: 9, fontWeight: "600" },
  notice: { fontSize: 10, fontWeight: "700", marginBottom: 5 },
  reset: { fontSize: 10, fontWeight: "800", paddingVertical: 4, marginBottom: 5 },
  actionRow: { flexDirection: "row", gap: 8 },
  secondary: { flex: 1, minHeight: 45, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontSize: 11, fontWeight: "800" },
  primary: { flex: 1.25, minHeight: 45, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "#10182888" },
  sheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 19 },
  settingsSheet: { maxHeight: "90%", borderTopLeftRadius: 27, borderTopRightRadius: 27, paddingHorizontal: 17, paddingTop: 11 },
  handle: { width: 42, height: 4, borderRadius: 2, backgroundColor: "#D0D5DD", alignSelf: "center", marginBottom: 17 },
  sheetTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  sheetTitle: { fontSize: 21, fontWeight: "800" },
  close: { fontSize: 28, lineHeight: 25, paddingLeft: 10 },
  option: { borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 15 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  check: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  optionTitle: { fontSize: 12, fontWeight: "800" },
  optionNote: { fontSize: 9, marginTop: 2 },
  settingsScroll: { gap: 10, paddingTop: 15, paddingBottom: 16 },
  settingsHint: { fontSize: 9, lineHeight: 15, paddingHorizontal: 2 },
  providerCard: { borderWidth: 1, borderRadius: 17, padding: 12 },
  providerTop: { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 10 },
  providerTitle: { fontSize: 12, fontWeight: "800" },
  providerNote: { fontSize: 9, lineHeight: 14, marginTop: 2 },
  outlineButton: { minHeight: 43, borderWidth: 1, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  outlineText: { fontSize: 11, fontWeight: "800" },
});
