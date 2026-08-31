# YouTube Transcript Studio — Mobile Design Plan

## Product intent

**YouTube Transcript Studio** is a portrait-first Android reading and editing tool. A user pastes transcript text copied from YouTube or another permitted source, optionally records the source link and language, then reads, searches, corrects, copies, and exports the result as a DOCX document. The app is intentionally local-only: no app account, YouTube login, provider key, or AI API is required.

## Screen list

| Screen | Primary content and functionality | Layout for one-handed use |
| --- | --- | --- |
| **Library** | Title, language, optional source-link fields, a multiline transcript paste field, clipboard Paste action, Save action, and a recent-document list showing language and update time. | The transcript field and primary button occupy the upper half; recent documents are a thumb-reachable list below. |
| **Source context** | Optional YouTube link and language fields let the user retain provenance without making network requests. | These fields stay secondary to the transcript paste field and remain reachable with one hand. |
| **Local save** | Text normalization, timestamp/SRT/WebVTT cue cleanup, source-text retention, and local persistence with clear success/error feedback. | Save feedback appears immediately below the paste field. |
| **Transcript workspace** | Video title, source-language badge, caption provenance/coverage warning, read/edit mode toggle, searchable editable transcript field, timestamps when available, and word/character count. | Edit, Copy, and Export actions sit in a compact bottom action bar. |
| **Original versus edited** | The workspace keeps the cleaned original and the edited copy separate, with a reset-to-original action. | Reset is a small secondary action beneath the counts, avoiding accidental loss. |
| **Export sheet** | Filename, export scope, document preview summary, and Android share/save action. | It opens as a bottom sheet with the final Export button at the bottom. |
| **Settings and privacy** | A concise local-storage notice and no provider configuration screen. | The product avoids settings that imply a server or account is required. |

## Key user flows

| Goal | User flow |
| --- | --- |
| **Save pasted transcript** | User opens Library → copies transcript text from YouTube → taps Paste from clipboard → optionally adds title, language, and source link → taps Save transcript → opens the Transcript workspace. |
| **Handle multiple videos** | User creates one local document per copied transcript and uses the title/source-link fields to keep playlist items organized. |
| **Correct and export** | User opens a saved transcript → enters Edit mode → amends text → saves locally → opens Export sheet → confirms filename and scope → saves or shares the DOCX file. |
| **Keep provenance honest** | User may save a source link, but the app clearly labels the result as Pasted text and never claims to have fetched or generated captions from the link. |

## Content and accuracy rules

The app treats every result as **user-supplied pasted text**, not as a legal or factual representation of the video. The workspace shows the entered language, the `Pasted text` source badge, and a notice that the user can edit the local copy. The exact normalized paste is retained separately from the cleaned original and edited text so users can revise without losing provenance.

## Data model

| Entity | Key fields | Local behavior |
| --- | --- | --- |
| **Transcript document** | ID, optional source link, title, language, `sourceText`, `originalText`, `editedText`, parsed segments, and update time | Persisted on-device and displayed in Library. |
| **Export settings** | Filename, include timestamps, scope, generated time | Applies only to the requested export and is not shared externally. |

## Visual language

The visual direction follows mainstream mobile reading apps and iOS Human Interface Guidelines: generous safe-area spacing, familiar navigation, system-like typography, a 44-point minimum interactive target, and restrained feedback. The main brand color is **Ink Blue `#175CD3`**, communicating focus and reliability; the reading surface is **Paper `#FFFEFB`**; body text is **Charcoal `#1D2939`**; secondary text is **Slate `#667085`**; ready/success states use **Verdant `#039855`**; and incomplete/error states use **Signal Red `#D92D20`**. Cards use a subtle **Mist `#F2F4F7`** background with **Line `#D0D5DD`** dividers. The interface remains portrait (9:16) and avoids dense desktop-style controls.

## Privacy boundary

Transcript history, source links, exact pasted text, cleaned text, and edits are stored on the device through AsyncStorage. No text or link is sent to a transcript provider by the no-key workflow. End users do not need a YouTube login or an app account, and no cross-device synchronization is included.
