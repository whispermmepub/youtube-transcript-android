# YouTube Transcript Studio — Mobile Design Plan

## Product intent

**YouTube Transcript Studio** is a portrait-first Android reading and editing tool. A user pastes a YouTube video or playlist link, requests an available source-language caption transcript, then reads, copies, corrects, and exports the result as a DOCX document. The interface must never imply that it has transcribed speech that was unavailable or that a transcript is guaranteed word-perfect. It preserves the language supplied by the source caption track and labels the caption source and coverage clearly.

## Screen list

| Screen | Primary content and functionality | Layout for one-handed use |
| --- | --- | --- |
| **Library** | A prominent link field, Paste action, process button, and a recent-document list showing title, source language, status, and update time. | The link field and primary button occupy the upper half; recent documents are a thumb-reachable list below. |
| **Import review** | Detected video or playlist identity, link type, selected caption/source-language track, privacy note, and start action. A playlist expands into per-video rows. | A bottom-anchored Start button remains reachable while content scrolls. |
| **Processing** | Clear stage indicator, current video count for playlists, cancellable progress, and any per-video failures without blocking completed items. | The Cancel control is an obvious text action beneath the progress indicator. |
| **Transcript workspace** | Video title, source-language badge, caption provenance/coverage warning, read/edit mode toggle, searchable editable transcript field, timestamps when available, and word/character count. | Edit, Copy, and Export actions sit in a compact bottom action bar. |
| **Playlist results** | A flat list of the playlist's videos with a status indicator and an accessible transcript item for each completed video. | Each row opens one transcript; a top-level Export all action is secondary, preventing accidental bulk files. |
| **Export sheet** | Filename, export scope, document preview summary, and Android share/save action. | It opens as a bottom sheet with the final Export button at the bottom. |
| **Settings and privacy** | Local-history controls, source-provider configuration status, document formatting preferences, and a concise statement of what is sent for processing. | All destructive controls are separated and require confirmation. |

## Key user flows

| Goal | User flow |
| --- | --- |
| **Transcribe one video** | User opens Library → pastes a YouTube video link → sees Import review → confirms the detected available source-language caption → starts processing → opens the Transcript workspace → reads, edits, copies, or exports DOCX. |
| **Process a playlist** | User pastes a playlist link → confirms the playlist and source-language choices → starts processing → monitors per-video progress → opens an individual completed transcript or exports selected completed entries. |
| **Correct and export** | User opens a saved transcript → enters Edit mode → amends text → saves locally → opens Export sheet → confirms filename and scope → saves or shares the DOCX file. |
| **Handle incomplete availability** | User submits a link without an accessible caption track → app explains that no source transcript could be obtained and does not create invented text → user may retry later or remove the item. |

## Content and accuracy rules

The app will treat every result as an **imported or provider-generated transcript**, not as a legal or factual representation of the video. The workspace shows the detected source language, source type, video title, and a notice that captions may include omissions or errors. “Verbatim” wording is shown only when the provider explicitly reports a complete authored caption track; otherwise the app uses neutral labels such as **caption transcript** or **automatic captions**. The editable local copy remains separate from the original imported transcript so users can revise it without losing provenance.

## Data model

| Entity | Key fields | Local behavior |
| --- | --- | --- |
| **Transcript job** | ID, link, type, title, status, selected language, created time, error message | Exists while an import is running and is retained for user-visible diagnostics. |
| **Transcript document** | ID, video ID, title, language, source type, original text, edited text, word count, updated time | Persisted on-device and displayed in Library. |
| **Playlist import** | ID, playlist ID, title, items, overall status | Groups related jobs while leaving each transcript independently readable and exportable. |
| **Export settings** | Filename, include timestamps, scope, generated time | Applies only to the requested export and is not shared externally. |

## Visual language

The visual direction follows mainstream mobile reading apps and iOS Human Interface Guidelines: generous safe-area spacing, familiar navigation, system-like typography, a 44-point minimum interactive target, and restrained feedback. The main brand color is **Ink Blue `#175CD3`**, communicating focus and reliability; the reading surface is **Paper `#FFFEFB`**; body text is **Charcoal `#1D2939`**; secondary text is **Slate `#667085`**; ready/success states use **Verdant `#039855`**; and incomplete/error states use **Signal Red `#D92D20`**. Cards use a subtle **Mist `#F2F4F7`** background with **Line `#D0D5DD`** dividers. The interface remains portrait (9:16) and avoids dense desktop-style controls.

## Privacy boundary

Transcript history is stored on the device by default. When a configured transcript provider is used, the app sends only the submitted public link and needed processing parameters to the app service; it does not embed provider credentials in the Android client. End users do not need a YouTube login or an app account for normal processing. No cross-device synchronization is included in the initial release.
