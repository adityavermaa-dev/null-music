<p align="center">
  <img src="./website/assets/favicon.png" alt="Null Music Logo" width="100" height="100" style="border-radius: 20px;" />
</p>

<h1 align="center">Null</h1>
<p align="center"><strong>Free Music Player for Android — No Ads, No Limits</strong></p>

<p align="center">
  <a href="https://null-music.netlify.app/app-release.apk"><img src="https://img.shields.io/badge/Download-APK-FA233B?style=for-the-badge&logo=android&logoColor=white" alt="Download APK" /></a>
  <a href="https://null-music.netlify.app"><img src="https://img.shields.io/badge/Website-Live-black?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/adit-ya15/music-player?color=blue&style=flat-square" alt="License" />
  <img src="https://img.shields.io/github/stars/adit-ya15/music-player?style=flat-square" alt="Stars" />
  <img src="https://img.shields.io/github/last-commit/adit-ya15/music-player?style=flat-square" alt="Last Commit" />
  <img src="https://img.shields.io/badge/platform-Android-3DDC84?style=flat-square&logo=android&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" />
</p>

---

## ✨ What is Null?

Null is a free, open-source music player for Android with access to millions of songs — no ads, no subscriptions, no tracking. Built with React, Capacitor, and a resilient Node.js backend with multi-provider fallback playback.

> **🌐 Website:** [null-music.netlify.app](https://null-music.netlify.app)  
> **📥 Download:** [Latest APK](https://null-music.netlify.app/app-release.apk)

---

## 📱 Screenshots

| Home | Now Playing | Search |
|:---:|:---:|:---:|
| <img src="./screenshots/Screenshot_2026-04-06-01-02-22-34_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> | <img src="./screenshots/Screenshot_2026-04-06-01-03-53-55_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> | <img src="./screenshots/Screenshot_2026-04-06-01-02-49-80_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> |

| Lyrics | Equalizer | Queue |
|:---:|:---:|:---:|
| <img src="./screenshots/Screenshot_2026-04-06-01-03-37-77_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> | <img src="./screenshots/Screenshot_2026-04-06-01-03-46-03_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> | <img src="./screenshots/Screenshot_2026-04-06-01-04-03-97_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> |

| Library | Radio | Features |
|:---:|:---:|:---:|
| <img src="./screenshots/Screenshot_2026-04-06-01-03-10-01_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> | <img src="./screenshots/Screenshot_2026-04-06-01-02-54-63_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> | <img src="./screenshots/Screenshot_2026-04-06-01-04-13-03_917bf2ce991166cdda6fa7069f598386.jpg" width="200" /> |

| DNA Overview | DNA Traits | DNA Helix |
|:---:|:---:|:---:|
| <img src="./screenshots/screen-dna1.jpg" width="200" /> | <img src="./screenshots/screen-dna2.jpg" width="200" /> | <img src="./screenshots/screen-dna3.jpg" width="200" /> |

---

## 🚀 Features

### 🎵 Playback & Audio
- **Background playback** with lockscreen and notification controls
- **Fallback-aware playback** — multi-provider pipeline (yt-dlp → Piped → Invidious) for maximum reliability
- **Equalizer** with 10 presets (Normal, Classical, Dance, Folk, Heavy Metal, Hip Hop, Jazz, Pop, Rock, Flat)
- **Queue controls** — shuffle, insert-next, smart dedup, and queue optimization
- **Resume state** — picks up right where you left off

### 🔍 Discovery & Search
- **Fast search** with rich metadata (artist, album, duration, thumbnails)
- **Trending charts** and personalized suggestions
- **Made For You** sections and Daily Mixes
- **Radio stations** — curated genre stations for quick listening (Bollywood, Pop, Lo-Fi, Hip Hop, EDM, and more)

### 📚 Library & Organization
- **Favorites** — heart songs to save them
- **Playlists** — create, edit, and manage custom playlists
- **Recently Played** and **Most Played** views
- **Offline downloads** — save songs and listen without internet

### 🎤 Lyrics & Visuals
- **Synced lyrics** from LRCLIB with auto-follow mode
- **Animated album art** backgrounds on the Now Playing screen
- **Theme switching** — light and dark mode

### 🧬 Music DNA *(Only on Null)*
- **DNA Helix** — animated visualization of your unique listening profile
- **Genre, mood, tempo & decade analysis** — deep insights into your taste
- **Acousticness profiling** — how organic vs electronic your taste is
- **Sonic Twins** — discover artists that match your DNA
- **Shareable DNA cards** — post your music identity on socials

### 👤 Account & Sync
- **Account login/signup** with session persistence
- **Cloud sync** — favorites, playlists, and history sync across devices
- **Feedback & issue reporting** built into the app

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18 + Vite |
| **Android Shell** | Capacitor 6 |
| **Backend API** | Node.js + Express |
| **Stream Resolution** | yt-dlp (primary) → Piped → Invidious (fallback) |
| **Lyrics** | LRCLIB API |
| **Auth** | JWT + session persistence |
| **Styling** | CSS3 with dark/light theme tokens |

---

## 📂 Repository Layout

```
null/
├── src/                    # React app and player state management
│   ├── components/         # UI components (Player, Queue, Library, etc.)
│   ├── pages/              # Route pages
│   └── hooks/              # Custom React hooks
├── android/                # Capacitor Android shell and native modules
├── backend/                # Node.js API server
│   ├── providers/          # Music source providers
│   ├── resolvers/          # Stream URL resolvers
│   ├── auth/               # JWT authentication
│   └── cache/              # Response caching layer
├── website/                # Marketing website (static HTML/CSS/JS)
├── shared/                 # Shared utilities
├── tests/                  # Unit and integration tests
├── server.mjs              # API server entry point
└── screenshots/            # App screenshots
```

---

## 🛠️ Local Development

### Prerequisites

- Node.js 22+
- npm 10+
- Java 21 (for Android builds)
- Android SDK (for device builds)

### Quick Start

```bash
# Clone the repo
git clone https://github.com/adit-ya15/music-player.git
cd music-player

# Install dependencies
npm install

# Start the backend server
npm run server

# Start the dev server (in a new terminal)
npm run dev
```

### Verify

```bash
npm run lint          # Code linting
npm test              # Run tests
npm run build         # Production build
```

---

## 📦 Android Build

### Debug APK

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug    # or .\gradlew.bat assembleDebug on Windows
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Release APK

> See [RELEASE_AND_UPDATE_GUIDE.md](./RELEASE_AND_UPDATE_GUIDE.md) for full signing and release instructions.

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleRelease
```

---

## 📖 Documentation

| Document | Description |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture and data flow |
| [SECURITY.md](./SECURITY.md) | Security practices and threat model |
| [PRIVACY.md](./PRIVACY.md) | Privacy policy and data handling |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Community guidelines |
| [ROADMAP.md](./ROADMAP.md) | Feature roadmap and milestones |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [RELEASE_AND_UPDATE_GUIDE.md](./RELEASE_AND_UPDATE_GUIDE.md) | Build, sign, and release process |
| [OPEN_SOURCE_RELEASE_CHECKLIST.md](./OPEN_SOURCE_RELEASE_CHECKLIST.md) | Pre-release checklist |

---

## 🌐 Marketing Website

The website source lives in `website/` and is deployed to [null-music.netlify.app](https://null-music.netlify.app).

Features:
- Apple-inspired interactive design with mouse-reactive particles
- Animated listening experience section with in-place expand/collapse
- Music DNA showcase section
- App screenshot carousel (12 screens)
- UPI support section with QR code
- Full SEO (Open Graph, Twitter Cards, JSON-LD structured data)

---

## ⚙️ Environment Variables

Copy the example files to get started:

```bash
cp .env.example .env
cp .env.production.example .env.production
```

> **⚠️ Never commit:** `.env` files, cookies, Android keystore credentials, or `android/keystore.properties`

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a PR.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## ❤️ Support

Null is free and open-source. If you enjoy it, consider supporting development:

- **UPI:** `aditya262701@okicici`
- **Website:** [null-music.netlify.app/#support](https://null-music.netlify.app/#support)
- **Star this repo** ⭐ — it helps more than you think!

---

## 📄 License

MIT — see [LICENSE](./LICENSE) for details.

---

<p align="center">
  Made with ❤ by <a href="https://github.com/adit-ya15">Aditya</a>
</p>
