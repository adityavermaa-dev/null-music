# Aura Music

Aura Music is an Android-first music player built with React, Vite, Capacitor, and a Node.js streaming backend. The app focuses on fast playback, resilient fallback behavior, offline downloads, personalized recommendations, background playback, widget support, synced lyrics when available, and native Android media controls.

## Features

- Background playback with lockscreen and notification controls
- Faster replay and skip behavior with resolved stream reuse
- Android home-screen widget and native equalizer presets
- Email login/signup plus phone OTP auth
- Synced likes, playlists, and recent listening per account
- Song radio and personalized recommendation fallbacks
- Offline downloads with in-app download management
- Continue listening, playback quality profiles, offline-only mode, and smart downloads
- Playlist rename/delete/reorder controls and library import/export
- Synced lyrics support when timed lyrics are available
- Local fallback mixes built from downloads, favorites, and recent plays

## Repo Layout

- `src/`: React app UI and player state
- `android/`: Capacitor Android shell and native media plugin
- `backend/`: cache and provider helpers used by the API server
- `server.mjs`: Express API for search, playback, lyrics, downloads, and recommendations
- `tests/`: Node test coverage for shared logic
- `flutter-template/`: separate Flutter UI scaffold kept outside the main shipping app

## Local Development

Install dependencies:

```bash
npm install
```

Run the backend:

```bash
npm run server
```

Run the web UI:

```bash
npm run dev
```

Verify the project:

```bash
npm run lint
npm test
npm run build
```

## Android App

Build the web assets first, then assemble the Android app:

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

For Windows PowerShell:

```powershell
npm run build
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

## Environment

Useful local settings live in `.env.example`.

Production-safe defaults live in `.env.production.example`.

Important environment variables:

- `VITE_API_BASE`: frontend API base URL
- `VITE_PHONE_OTP_ENABLED`: optional UI kill-switch for the OTP flow
- `RECO_API_KEY`: protects recommendation endpoints in production
- `AUTH_TOKEN_SECRET`: signs login sessions for account sync
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`: required for phone OTP verification
- `REDIS_URL`: optional Redis cache for production reliability
- `YT_DLP_BIN`: path to `yt-dlp`
- `YT_COOKIES_FILE`: optional absolute path to a local cookies export kept outside the repo

## Production Notes

- Put the backend behind HTTPS and set `TRUST_PROXY` correctly.
- Keep cookies files, API keys, and signing materials out of Git.
- Set `AUTH_TOKEN_SECRET` explicitly before shipping public builds.
- Configure Twilio Verify before enabling phone OTP in production.
- Add Redis for cache durability across restarts.
- Test real-device behavior for weak network, offline playback, queue advance, and download recovery.
- Create signed Android release builds before distribution.

## Platform Support

- Android app: primary target with widget, equalizer, downloads, and native media integration
- Web preview: useful for development and UI checks, with graceful fallbacks where native APIs are unavailable

## Open Source Docs

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security Policy](./SECURITY.md)
- [Privacy Notes](./PRIVACY.md)
- [Roadmap](./ROADMAP.md)
- [Release Checklist](./OPEN_SOURCE_RELEASE_CHECKLIST.md)

## License

MIT. See [LICENSE](./LICENSE).
