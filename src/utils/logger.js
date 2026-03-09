export const logInfo = (tag, message, meta = {}) => {
  if (typeof console === 'undefined') return;
  console.groupCollapsed(`[Aura][${tag}] ${message}`);
  if (meta && Object.keys(meta).length > 0) {
    console.log('meta:', meta);
  }
  console.groupEnd();
};

export const logError = (tag, error, meta = {}) => {
  if (typeof console === 'undefined') return;
  console.groupCollapsed(`[Aura][${tag}] error`);
  if (meta && Object.keys(meta).length > 0) {
    console.log('meta:', meta);
  }
  console.error(error);
  console.groupEnd();
};

export const friendlyErrorMessage = (error, fallback = 'Something went wrong. Please try again.') => {
  const status = error?.response?.status;
  if (status === 429) return 'Too many requests right now. Please wait a moment and retry.';
  if (status >= 500) return 'Server is temporarily unavailable. Please retry in a few seconds.';
  if (error?.code === 'ECONNABORTED') return 'Request timed out. Please check connection and retry.';
  if (error?.message) return error.message;
  return fallback;
};
