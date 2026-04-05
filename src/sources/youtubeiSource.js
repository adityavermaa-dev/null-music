let youtubeiModulePromise = null;
let innertubePromise = null;

function scoreAudioFormat(format) {
  const isAudioOnly = !format?.has_video;
  const bitrate = Number(format?.bitrate || format?.average_bitrate || 0);
  const mimeType = String(format?.mime_type || '').toLowerCase();
  const isOpus = mimeType.includes('opus');

  return (isAudioOnly ? 1_000_000 : 0) + (isOpus ? 10_000 : 0) + bitrate;
}

function pickBestAudioUrl(info) {
  const formats = [
    ...(Array.isArray(info?.streaming_data?.adaptive_formats) ? info.streaming_data.adaptive_formats : []),
    ...(Array.isArray(info?.streaming_data?.formats) ? info.streaming_data.formats : []),
  ];

  const audioFormats = formats
    .filter((format) => format?.url && (format?.has_audio || !format?.has_video))
    .sort((left, right) => scoreAudioFormat(right) - scoreAudioFormat(left));

  return audioFormats[0]?.url || '';
}

async function getInnertubeClient() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      if (!youtubeiModulePromise) {
        youtubeiModulePromise = import('youtubei.js/web.bundle');
      }

      const { Innertube } = await youtubeiModulePromise;
      return Innertube.create({
        lang: 'en',
        location: 'US',
        retrieve_player: true,
        generate_session_locally: true,
      });
    })().catch((error) => {
      innertubePromise = null;
      throw error;
    });
  }

  return innertubePromise;
}

async function resolveWithTimeout(task, timeoutMs) {
  let timer = null;

  try {
    return await Promise.race([
      task(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveYoutubeiClientStream(videoId, options = {}) {
  if (!videoId) return null;

  const timeoutMs = Math.max(1500, Number(options.timeoutMs || 3500));

  try {
    return await resolveWithTimeout(async () => {
      const innertube = await getInnertubeClient();

      let info = null;
      try {
        info = await innertube.music.getInfo(videoId);
      } catch {
        info = null;
      }

      if (!pickBestAudioUrl(info)) {
        try {
          info = await innertube.getInfo(videoId);
        } catch {
          info = null;
        }
      }

      const streamUrl = pickBestAudioUrl(info);
      if (!streamUrl) return null;

      return {
        streamUrl,
        streamSource: 'youtubei-client',
        verified: true,
      };
    }, timeoutMs);
  } catch {
    return null;
  }
}