# Null Architecture Overview

## Stack

- Frontend: React + Vite in src/
- Android shell: Capacitor in android/
- Backend: Express API in server.mjs with modules in backend/
- Shared data helpers: shared/

## Runtime Flow

1. User searches from app UI.
2. Frontend calls API endpoints through /api.
3. Backend resolves tracks from supported providers.
4. Playback uses fallback strategy when source quality is poor or unavailable.
5. Queue and player state are persisted and reused for seamless playback.

## Key Modules

- Player orchestration: src/context/PlayerContext.jsx
- Source resolution layer: src/sources/
- Search and recommendation APIs: src/api/
- Download and cache logic: backend/cache/
- Provider adapters: backend/providers/

## Reliability and Fallback

- Multi-provider source resolution with fallback pathing.
- Preview/short stream replacement for better full-track continuity.
- Queue resilience in network transitions.
- Offline-first behavior through downloaded tracks and local recommendation fallback.

## Security and Secrets

- Secrets stay in .env and local Android signing files only.
- No signing keystore or credentials in repository.
- Recommendation endpoints can be protected with RECO_API_KEY.

## Release Artifacts

- Web assets are built to dist/.
- Android consumes dist/ through Capacitor sync.
- Release builds are produced via Gradle in android/.
