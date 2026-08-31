# Project TODO

- [ ] Implement the Library screen with YouTube video and playlist link intake.
- [ ] Add safe local models and persistence for transcript documents, playlist imports, and user edits.
- [ ] Implement the transcript workspace with preview, edit, save, copy, search, and source-language details.
- [ ] Implement DOCX document generation and Android save/share export.
- [ ] Add playlist import review, per-video processing states, and completed-item navigation.
- [ ] Add a server-side provider boundary for permitted YouTube metadata and caption retrieval.
- [ ] Add clear availability, provenance, error, and privacy states.
- [ ] Add unit tests for link parsing, transcript editing, and DOCX export preparation.
- [ ] Generate a custom app icon and complete app branding configuration.
- [ ] Verify the Android build and primary user flows.
- [ ] Create and link a new GitHub repository without storing exposed credentials.
- [ ] Ensure the app has no user account or YouTube login requirement for normal transcript use.
- [ ] Validate and integrate an automatic server-side transcript provider for pasted public video and playlist links.
- [ ] Create the separate GitHub repository and return its URL after secure authorization.
- [ ] Do not use or store the PAT that was exposed in chat; rely on a rotated credential or OAuth connection.
- [ ] Create the private GitHub repository via GitHub REST API using a newly rotated, repository-scoped credential.
- [ ] Never use the PAT previously pasted into chat or commit any GitHub credential to the repository.
- [ ] Change repository visibility from private to public only after confirming no credentials are present in tracked source.
