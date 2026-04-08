# Open Source Release Checklist

Use this before every public release.

## 1) Source Hygiene

- Confirm no secrets are committed (.env, keystore, cookies, tokens).
- Confirm local artifacts are not committed (build folders, debug files, temp scripts).
- Run a secrets scan against full git history.

## 2) Build and Test Gates

- CI passes for lint, tests, web build, and Android debug build.
- Local commands pass:
	- npm run lint
	- npm test
	- npm run build
- Signed release artifact can be generated successfully.

## 3) Versioning and Changelog

- Increment versionCode in [android/app/build.gradle](android/app/build.gradle).
- Update versionName in [android/app/build.gradle](android/app/build.gradle).
- Update [CHANGELOG.md](CHANGELOG.md) with release notes.

## 4) Product Quality Validation

- Manual smoke test on real devices:
	- launch
	- search
	- playback fallback
	- queue actions
	- offline downloads
	- auth sync
- No critical regressions compared to previous production release.

## 5) Release Rollout Safety

- Start with internal track.
- Then closed test.
- Use staged production rollout (5% -> 20% -> 50% -> 100%).
- Monitor crash and ANR rates between rollout stages.

## 6) Documentation and OSS Readiness

- README is current and includes latest screenshots.
- Release guide and architecture docs are up to date.
- Public docs are linked:
	- [CONTRIBUTING.md](CONTRIBUTING.md)
	- [SECURITY.md](SECURITY.md)
	- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 7) Post-Release

- Tag git release (example: v1.6.0).
- Publish release notes.
- Track issues for 48 hours and hotfix if needed.
