import PQueue from 'p-queue';

const concurrency = Math.max(
  1,
  Number(process.env.QUEUE_CONCURRENCY || process.env.YTDLP_CONCURRENCY || 2)
);

const timeout = Math.max(3000, Number(process.env.YTDLP_QUEUE_TIMEOUT_MS || 30000));

export const ytdlpQueue = new PQueue({
  concurrency,
  timeout,
  throwOnTimeout: true,
});
