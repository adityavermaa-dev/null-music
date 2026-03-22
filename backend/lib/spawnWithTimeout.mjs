import { spawn } from 'child_process';

export function spawnWithTimeout(bin, args, options = {}) {
  const {
    timeoutMs = 8000,
    cwd,
    env,
    stdio = ['ignore', 'pipe', 'pipe'],
  } = options;

  const proc = spawn(bin, args, {
    cwd,
    env,
    stdio,
    windowsHide: true,
  });

  let timedOut = false;
  const useTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const timer = useTimeout
    ? setTimeout(() => {
        timedOut = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs)
    : null;

  const done = new Promise((resolve, reject) => {
    proc.once('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timeout after ${timeoutMs}ms`));
      } else {
        resolve({ code });
      }
    });
  });

  return { proc, done };
}
