# Null Android Release and Update Guide

This is the exact process to create a production release and safely ship updates without breaking existing users.

## A) One-time setup (do once)

### 1. Create a release keystore

Run this from any safe local folder:

```powershell
keytool -genkeypair -v -keystore null-release.jks -alias null_release -keyalg RSA -keysize 2048 -validity 10000
```

Important:

- Keep this keystore forever.
- Back it up in 2 secure places.
- Never commit it to Git.

### 2. Add signing properties locally

This repo now includes:

- [android/keystore.properties.example](android/keystore.properties.example)

Create your local file:

- android/keystore.properties

With values like:

```ini
MYAPP_UPLOAD_STORE_FILE=../keystores/null-release.jks
MYAPP_UPLOAD_KEY_ALIAS=null_release
MYAPP_UPLOAD_STORE_PASSWORD=your_store_password
MYAPP_UPLOAD_KEY_PASSWORD=your_key_password
```

This file is gitignored.

### 3. Keep package identity stable

Do not change these unless intentionally creating a new app listing:

- applicationId in [android/app/build.gradle](android/app/build.gradle)
- appId in [capacitor.config.json](capacitor.config.json)

## B) Build a release APK/AAB

### 1. Prepare web + Android shell

From repo root:

```powershell
npm install
npm run build
npx cap sync android
```

### 2. Build release artifacts

```powershell
cd android
.\gradlew.bat clean
.\gradlew.bat assembleRelease
.\gradlew.bat bundleRelease
```

Output paths:

- APK: android/app/build/outputs/apk/release/
- AAB: android/app/build/outputs/bundle/release/

Use AAB for Play Store upload.

## C) What each version field means

File: [android/app/build.gradle](android/app/build.gradle)

- versionCode: integer used by Android for update ordering (must always increase)
- versionName: user-facing version string (for example 1.2.0)

Rule for every release:

1. Increase versionCode by at least 1.
2. Set versionName to your new release tag.

Example:

- previous: versionCode 12, versionName 1.4.2
- next: versionCode 13, versionName 1.5.0

## D) Safe update flow (without breaking current app)

### 1. Before upload

Run and pass:

```powershell
npm run lint
npm test
npm run build
```

Then manually test on at least 2 real devices:

- app launch and restore
- search
- queue edit actions
- fallback playback
- downloads and offline mode
- account sign-in and sync

### 2. Play Console rollout strategy

Use staged rollout:

1. Internal testing
2. Closed testing
3. Production 5%
4. Production 20%
5. Production 50%
6. Production 100%

At each stage:

- watch crash rate and ANR
- monitor playback failures
- pause rollout if regressions appear

## E) Release management checklist per version

1. Create release branch (example: release/1.6.0)
2. Freeze features, only fix blockers
3. Update versionCode/versionName
4. Update [CHANGELOG.md](CHANGELOG.md)
5. Build AAB
6. Upload to testing track
7. Validate metrics
8. Promote to production gradually
9. Tag release in git (example: v1.6.0)

## F) Things that must never change

Never change after first production release:

- keystore and alias
- applicationId/appId

If you lose keystore, future updates to the same Play listing become impossible.

## G) Open-source safety

Always verify before pushing:

- no keystore files committed
- no android/keystore.properties committed
- no .env secrets committed

Reference docs:

- [OPEN_SOURCE_RELEASE_CHECKLIST.md](OPEN_SOURCE_RELEASE_CHECKLIST.md)
- [SECURITY.md](SECURITY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
