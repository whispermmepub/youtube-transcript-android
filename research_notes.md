# Transcript Provider Research Notes

## Verified official API limits

Google’s official YouTube Data API provides `playlistItems.list` for enumerating items in a specified playlist. This enables a server-side import review for a public or authorized playlist, subject to the API’s normal visibility and quota rules. The initial app can validate and expand permitted playlist links, then show processing state per item.

Google’s official `captions.download` endpoint is not a general public-video transcript API. The documentation states that the request requires OAuth authorization with a YouTube scope and that the user must have permission to edit the video. The endpoint may return a 403 error when the request lacks sufficient permission. Therefore this release must not promise a full transcript for arbitrary public YouTube links solely through the official API.

## Product decision

The mobile client will implement the complete local workspace and a server-side **provider boundary**. It will support link parsing, playlist grouping, source-language display, accurate availability states, transcript editing, copying, and DOCX export immediately. The import action will accept transcript responses only from an authorized provider implementation. The default official path is appropriate for videos that the connected creator or content owner is permitted to edit. For any link whose captions are inaccessible, the app will state the limitation and create no fabricated transcript.

## Automatic no-login route

TranscriptAPI documents a REST API for submitting a YouTube video URL and receiving structured transcript segments, detected language, duration, and title. Its public site also describes playlist extraction. This makes it a viable **server-side provider candidate** for the requested user experience: the Android app user pastes a link and does not sign in to YouTube or create an app account. A service-owner API key is still required and must remain only in the backend environment, never in the mobile bundle. The app must identify the transcript as provider-supplied, preserve the returned source language, and show a useful unavailable state if the provider cannot retrieve a video.

## References

[1] [YouTube Data API: Captions download](https://developers.google.com/youtube/v3/docs/captions/download)

[2] [YouTube Data API: PlaylistItems list](https://developers.google.com/youtube/v3/docs/playlistItems/list)

[3] [TranscriptAPI product page](https://transcriptapi.com/)

[4] [TranscriptAPI documentation](https://transcriptapi.com/docs/)
