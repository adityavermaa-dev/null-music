import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.mjs';
import { spawnWithTimeout } from '../lib/spawnWithTimeout.mjs';

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function getBundledBgutilPluginDir() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const pluginDir = path.resolve(__dirname, '../../bgutil-ytdlp-pot-provider/plugin');
    return fs.existsSync(pluginDir) ? pluginDir : null;
  } catch {
    return null;
  }
}

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
    playerClient = process.env.YT_PLAYER_CLIENTS || 'mweb',
    cookiesFile = process.env.YT_COOKIES_FILE,
    jsRuntimes = process.env.YT_DLP_JS_RUNTIMES || 'node',
    proxy = getYtdlpProxy(),
    pluginDirs = process.env.YT_DLP_PLUGIN_DIRS || process.env.YTDLP_PLUGIN_DIRS || '',
    enableBundledBgutilPlugin = process.env.YT_DLP_ENABLE_BGUTIL_PLUGIN,
    getUrl = false,
    outputToStdout = false,
  } = options;

  // Important: avoid reading machine/user-level yt-dlp config (it can force cookies).
  const args = ['--ignore-config', '-f', 'bestaudio', '--no-playlist'];

  // Optional plugin dirs (e.g., bundled PO token provider).
  for (const pluginDir of splitCsv(pluginDirs)) {
    args.push('--plugin-dirs', pluginDir);
  }

  const allowBundled = String(enableBundledBgutilPlugin || '').trim().toLowerCase() !== 'false';
  const bundledBgutil = allowBundled ? getBundledBgutilPluginDir() : null;
  if (bundledBgutil) args.push('--plugin-dirs', bundledBgutil);

  // Optional explicit cookies file (helps with sign-in / age-gated videos).
  if (cookiesFile) args.push('--cookies', cookiesFile);
  if (jsRuntimes) args.push('--js-runtimes', jsRuntimes);
  if (proxy) args.push('--proxy', proxy);

  // Basic headers help reduce bot-gating, without requiring cookies.
  args.push('--add-header', 'User-Agent: com.google.android.youtube/19.09.37 (Linux; Android 13)');
  args.push('--add-header', 'Accept-Language: en-US,en;q=0.9');

  // Prefer mweb with webpage/config skipping to reduce 429s on datacenter IPs.
  const skipWebpage = process.env.YT_PLAYER_SKIP || 'webpage,configs';
  const fetchPot = String(process.env.YT_FETCH_POT || 'auto').trim();
  const extractorParts = [`player_client=${playerClient}`];
  if (skipWebpage) extractorParts.push(`player_skip=${skipWebpage}`);
  if (fetchPot) extractorParts.push(`fetch_pot=${fetchPot}`);
  args.push('--extractor-args', `youtube:${extractorParts.join(';')}`);

  // Optional override for bgutil POT provider base URL
  const bgutilBaseUrl = String(process.env.YT_POT_PROVIDER_URL || process.env.YT_BGUTIL_BASE_URL || '').trim();
  if (bgutilBaseUrl) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${bgutilBaseUrl}`);
  }
  
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
    msg.includes('private video') ||
    // Typical for embeds / restricted playback contexts
    msg.includes('watch video on youtube') ||
    msg.includes('error code: 152')
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

  // Treat known non-retryable failures as unplayable so higher-level logic doesn't hammer.
  if (isNonRetryableYtdlpError(err)) {
    logger.warn('provider.ytdlp', 'yt-dlp returned non-retryable error (skipping)', {
      videoId,
      code,
      playerClient: options?.playerClient || process.env.YT_PLAYER_CLIENTS || 'mweb',
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
      playerClient: options?.playerClient || process.env.YT_PLAYER_CLIENTS || 'mweb',
      hasCookies: Boolean(process.env.YT_COOKIES_FILE),
      hasProxy: Boolean(getYtdlpProxy()),
      stderr: err.slice(0, 300),
    });
    return null;
  }

  return url;
}
