# YouTube Transcript Studio — AI Handoff

## Current product decision

This project is now intentionally a **no-key, local-only Android transcript editor**. The user does not want Groq, Gemini, TranscriptAPI, YouTube OAuth, or any other provider credential in the normal workflow. The user copies transcript text from YouTube or another permitted source, pastes it into the app, and then reads, edits, copies, and exports it as DOCX.

The app must not claim that a YouTube link alone produces a transcript. A YouTube link is optional source context only. The current product promise is:

> Copy transcript text → paste into the app → save locally → preview/edit/search/reset/copy → export DOCX.

The user may later request an optional AI proofreading feature. If that happens, keep the original text immutable and make AI output a separate suggestion. Do not make Groq or Gemini a requirement for the core app.

## Repository and project

| Item | Value |
| --- | --- |
| Public GitHub repository | https://github.com/whispermmepub/youtube-transcript-android |
| Local project | `/home/ubuntu/youtube-transcript-android` |
| Expo app name | `YouTube Transcript Studio` |
| Stable app slug | `youtube-transcript-android` |
| Platform | Expo SDK 54 Android/mobile app |
| Latest checkpoint at handoff | Use the most recent `manus-webdev://...` checkpoint shown in the project UI |

The repository is public by user request. The PAT that was previously pasted into chat was exposed and must never be reused or committed. It should remain revoked/rotated. No GitHub or transcript-provider credential belongs in this repository.

## Implemented behavior

### Library screen

`app/(tabs)/index.tsx` is the main screen. It contains a document title field, an optional language field, an optional YouTube source URL field, a multiline transcript field, a clipboard paste action, and a Save transcript action. Documents are saved to the device and listed under Recent transcripts. No account, YouTube login, or API key is requested.

### Pasted transcript parser

`lib/transcript-content.ts` is platform-independent and supports:

- Plain multiline transcript text.
- WebVTT-style `WEBVTT` cues.
- SRT-style time ranges such as `00:01:02,000 --> 00:01:04,000`.
- Bracket or inline time markers such as `[00:03] Text`.
- Basic HTML cue-tag cleanup.
- Unicode text, including Burmese.

The parser returns both `sourceText` (the exact normalized paste) and `cleanText` (the editable transcript). It also creates timestamp-bearing segments when cues are found.

### Local document model and persistence

`shared/transcript.ts` defines `TranscriptDocument`, `TranscriptSegment`, and `TranscriptSource`. The `pasted` source value is used for no-key imports. `sourceText` is optional and stores the original pasted content separately from `originalText` and `editedText`.

`lib/transcript-store.ts` uses AsyncStorage under `youtube-transcript-studio.documents.v1`. It loads, persists, and updates on-device documents. `lib/transcript-content.ts` owns the pure text conversion logic; the store re-exports `textToDocument` for client compatibility.

### Transcript workspace

The workspace supports Preview and Edit modes, source-language/provenance badges, word and character counts, transcript search with match count, local save, reset-to-original, and clipboard copy. It shows a clear local-storage notice and avoids claiming automatic YouTube retrieval.

### DOCX export

`lib/docx-core.ts` creates a dependency-light DOCX ZIP package. `lib/docx-export.ts` handles native file creation and Android share-sheet delivery. Export supports optional timestamp inclusion, preserves Unicode text, and labels pasted documents as `Pasted text` in metadata.

## Important files

| File | Role |
| --- | --- |
| `app/(tabs)/index.tsx` | Main library, paste form, workspace, search, edit, copy, export UI |
| `lib/transcript-content.ts` | Pure no-key parser and pasted-document builder |
| `lib/transcript-store.ts` | AsyncStorage persistence and document updates |
| `lib/docx-core.ts` | Platform-independent DOCX generation |
| `lib/docx-export.ts` | Expo filesystem and sharing wrapper |
| `shared/transcript.ts` | Shared transcript types |
| `server/routers.ts` | Minimal auth/system router; no transcript provider endpoint remains |
| `design.md` | Portrait-first mobile design specification |
| `README.md` | Public repository usage and privacy documentation |
| `todo.md` | Project history and pending work checklist |
| `app.config.ts` | App name, slug, package IDs, and branding paths |
| `theme.config.js` | Ink Blue reading palette |

## Verification

Run these commands from `/home/ubuntu/youtube-transcript-android`:

```bash
pnpm test
pnpm check
pnpm dev
```

The latest verification completed with **2 test files passing, 6 tests passing, 1 auth test skipped**, and `tsc --noEmit` passing. The skipped auth test is inherited scaffold behavior and is unrelated to the local transcript flow.

The parser test covers a Burmese WebVTT/SRT-style sample, timestamp extraction, cleaned text, source-text retention, and pasted document metadata. DOCX tests cover package generation. You should still validate native Android file sharing on a real device after generating an APK.

## APK/install handoff

Do not manually build an APK with sandbox system binaries. Save a checkpoint first, then use the project Management UI **Publish** action to generate the installable Android artifact. The user can download the generated APK and install it on an Android device. Publishing is intentionally a user-triggered UI action.

The app can be previewed in the project Preview panel. The first production-like test should be:

1. Paste Burmese or English transcript text.
2. Add a title and language such as `my` or `en`.
3. Save it.
4. Open it from Recent transcripts.
5. Search a word in Preview.
6. Enter Edit, change a sentence, save, and verify persistence.
7. Reset to original and verify the original cleaned paste returns.
8. Copy the text.
9. Export DOCX with and without timestamps.
10. Open/share the DOCX on a real Android device.

## Do not reintroduce

Do not reintroduce `TRANSCRIPT_API_KEY`, `GITHUB_REPO_TOKEN`, Groq, Gemini, YouTube OAuth, user accounts, or server transcript fetching unless the user explicitly changes the product decision. Do not put any secret in `app.config.ts`, the Android bundle, source files, README, or GitHub.

Do not promise “every word from any YouTube link” in this no-key version. That would require an external retrieval/transcription route and can fail for unavailable captions, blocked content, or platform restrictions. The current version is intentionally honest: it edits and exports text supplied by the user.

## Suggested next improvements

The highest-value next steps are native Android testing of the share sheet, better playlist-style grouping for multiple pasted transcripts, and optional local formatting controls such as paragraph spacing and a DOCX filename field. If AI proofreading is requested later, implement it as an optional provider adapter with secure server-side configuration and a side-by-side suggestion view; never overwrite `sourceText` or `originalText` automatically.
