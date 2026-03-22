import { logger } from '../lib/logger.mjs';
import { spawnWithTimeout } from '../lib/spawnWithTimeout.mjs';

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
    playerClient = process.env.YT_PLAYER_CLIENTS || 'android_vr,ios,android',
    getUrl = false,
    outputToStdout = false,
    jsRuntimeNode = false,
  } = options;

  const args = ['-f', 'bestaudio', '--no-playlist'];

  // Basic headers help reduce bot-gating, without requiring cookies.
  // (Do NOT add cookies here.)
  args.push('--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  args.push('--add-header', 'Accept-Language: en-US,en;q=0.9');

  if (jsRuntimeNode) {
    args.push('--js-runtimes', 'node');
  }

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

export async function ytdlpGetUrl(bin, videoId, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(process.env.YTDLP_TIMEOUT_MS || process.env.YTDLP_TIMEOUT || 8000)
  );
  const args = buildYtdlpArgs(videoId, { ...options, getUrl: true });

  const { proc, done } = spawnWithTimeout(bin, args, { timeoutMs });
  const { out, err } = await collectStdout(proc);
  await done;

  const url = out.trim().split(/\r?\n/)[0]?.trim();
  if (!url) {
    logger.warn('provider.ytdlp', 'yt-dlp returned no URL', { videoId, stderr: err.slice(0, 300) });
    return null;
  }

  return url;
}
