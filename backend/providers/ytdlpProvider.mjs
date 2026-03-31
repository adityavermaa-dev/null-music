import { logger } from '../lib/logger.mjs';
import { spawnWithTimeout } from '../lib/spawnWithTimeout.mjs';

export function getYtdlpProxy() {
  return String(
    process.env.YT_DLP_PROXY ||
    process.env.YTDLP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    ''
  ).trim();
}

function collectStdout(proc, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';

    proc.stdout?.on('data', (chunk) => {
      out += chunk.toString();
      if (out.length > limit) {
        reject(new Error('yt-dlp stdout too large'));
      }
    });

    proc.stderr?.on('data', (chunk) => {
      err += chunk.toString();
      if (err.length > limit) {
        // keep last chunk, but do not reject yet
        err = err.slice(-limit);
      }
    });

    proc.once('error', reject);
    proc.once('close', () => resolve({ out, err }));
  });
}

export function buildYtdlpArgs(videoId, options = {}) {
  const {
    extractorArgs = process.env.YT_EXTRACTOR_ARGS || '',
    sourceAddress = process.env.YT_SOURCE_ADDRESS,
    playerClient = process.env.YT_PLAYER_CLIENTS || 'android_vr',
    cookiesFile = process.env.YT_COOKIES_FILE,
    jsRuntimes = process.env.YT_DLP_JS_RUNTIMES || 'node',
    proxy = getYtdlpProxy(),
    getUrl = false,
    outputToStdout = false,
  } = options;

  // Important: avoid reading machine/user-level yt-dlp config (it can force cookies).
  const args = ['--ignore-config', '-f', 'bestaudio', '--no-playlist'];

  // Optional explicit cookies file (helps with sign-in / age-gated videos).
  if (cookiesFile) args.push('--cookies', cookiesFile);
  if (jsRuntimes) args.push('--js-runtimes', jsRuntimes);
  if (proxy) args.push('--proxy', proxy);

  // Basic headers help reduce bot-gating, without requiring cookies.
  // (Do NOT add cookies here.)
  args.push('--add-header', 'User-Agent: com.google.android.youtube/19.09.37 (Linux; Android 13)');
  args.push('--add-header', 'Accept-Language: en-US,en;q=0.9');

  // Always set a cookie-free player client. yt-dlp supports trying multiple clients via comma-separated list.
  if (playerClient) args.push('--extractor-args', `youtube:player_client=${playerClient}`);
  if (extractorArgs) args.push('--extractor-args', extractorArgs);

  if (sourceAddress) args.push('--source-address', sourceAddress);

  if (getUrl) args.push('--get-url');
  if (outputToStdout) args.push('-o', '-');

  // Prefer youtube.com over music.youtube.com to avoid additional consent/login redirects.
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

function isNonRetryableYtdlpError(stderr = '') {
  const msg = String(stderr || '').toLowerCase();
  return (
    msg.includes('sign in to confirm') ||
    msg.includes('cookies are required') ||
    msg.includes('this video is age-restricted') ||
    msg.includes('confirm your age') ||
    msg.includes('please sign in') ||
    msg.includes('account has been terminated') ||
    msg.includes('private video')
  );
}

export async function ytdlpGetUrl(bin, videoId, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(process.env.YTDLP_TIMEOUT_MS || process.env.YTDLP_TIMEOUT || 8000)
  );
  const args = buildYtdlpArgs(videoId, { ...options, getUrl: true });

  const { proc, done } = spawnWithTimeout(bin, args, { timeoutMs });
  const { out, err } = await collectStdout(proc);
  const { code } = await done;

  // Treat login/cookie-required content as unplayable without cookies.
  // Return null (non-retryable) so higher-level retry logic doesn't keep hammering.
  if (isNonRetryableYtdlpError(err)) {
    logger.warn('provider.ytdlp', 'yt-dlp requires sign-in/cookies (skipping)', {
      videoId,
      code,
      playerClient: options?.playerClient || process.env.YT_PLAYER_CLIENTS || 'android_vr',
      hasCookies: Boolean(process.env.YT_COOKIES_FILE),
      hasProxy: Boolean(getYtdlpProxy()),
      stderr: err.slice(0, 300),
    });
    return null;
  }

  const url = out.trim().split(/\r?\n/)[0]?.trim();
  if (!url) {
    logger.warn('provider.ytdlp', 'yt-dlp returned no URL', {
      videoId,
      code,
      playerClient: options?.playerClient || process.env.YT_PLAYER_CLIENTS || 'android_vr',
      hasCookies: Boolean(process.env.YT_COOKIES_FILE),
      hasProxy: Boolean(getYtdlpProxy()),
      stderr: err.slice(0, 300),
    });
    return null;
  }

  return url;
}
