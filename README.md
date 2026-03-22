# Null

This repo contains:

- A Node.js backend (`server.mjs`) that provides music search + streaming endpoints.
- A Flutter (Android/Kotlin) app template under `flutter-template/`.

## License

MIT — see LICENSE.

## Contributing

See CONTRIBUTING.md.

## Security

See SECURITY.md.

## Backend

Run the API server:

```bash
npm install
npm run server
```

Default: `http://localhost:3001`

## Frontend (Vite)

Run the web app in dev mode (uses the proxy in `vite.config.js`):

```bash
npm run dev
```

### Env

- `VITE_API_BASE` (optional)
	- Default: `/api` (same origin)
	- Set this at build-time when the frontend must call a different host, e.g. `VITE_API_BASE=https://music.example.com/api`
- `RECO_API_KEY` (optional, server)
	- When set, `/api/track` and `/api/recommendations` require either `x-api-key: <key>` or `Authorization: Bearer <key>`.
- `RECO_INCLUDE_SCORES` (optional, server)
	- When set (e.g. `true`), includes a numeric `score` field in recommendation items for debugging.

## Flutter (Android, Kotlin)

This repo does not include a generated Flutter project by default. After installing Flutter, run:

```powershell
./scripts/setup-flutter-null.ps1
```

That will create `null_app/` (Android + Kotlin), copy the UI from `flutter-template/`, and apply the launcher icon resources.

Run on Android emulator (backend on your PC):

```powershell
cd null_app
flutter run --dart-define=AURA_BASE_URL=http://10.0.2.2:3001
```

Run on a real device (replace with your PC IP):

```powershell
flutter run --dart-define=AURA_BASE_URL=http://192.168.x.x:3001
```
