# YouTube Transcript Studio

YouTube Transcript Studio is a portrait-first Expo Android app for importing available source-language transcripts from YouTube video or playlist links, then previewing, editing, copying, and exporting them as DOCX files.

## Current workflow

Paste a `youtube.com` or `youtu.be` video/playlist link into the app. The server-side transcript adapter calls the configured provider, while the Android client keeps the resulting documents and edits on-device without requiring a user account.

## Configuration

Set `TRANSCRIPT_API_KEY` in the server environment to enable the automatic provider route. Never put provider credentials in the Android bundle. The GitHub repository credential is only used for repository operations and must not be committed.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm dev
```

The provider route is intentionally explicit about caption availability and source type. Automatic captions can contain omissions or recognition errors, and the app presents that provenance in the transcript workspace.
