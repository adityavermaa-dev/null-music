import axios from 'axios';
import { friendlyErrorMessage, logError } from '../utils/logger';

import { buildApiUrl } from './apiBase';

const requestReco = async (tag, method, path, data, config, fallbackMessage) => {
  try {
    const response = await axios({
      method,
      url: buildApiUrl(path),
      data,
      ...config,
    });
    return { ok: true, response, error: null };
  } catch (error) {
    logError(tag, error, { path });
    return {
      ok: false,
      response: null,
      error: friendlyErrorMessage(error, fallbackMessage),
    };
  }
};

export const recommendationsApi = {
  trackSafe: async ({ userId, song, action = 'play' }) => {
    return await requestReco(
      'reco.track',
      'post',
      '/track',
      { userId, action, song },
      { timeout: 4000 },
      'Tracking is unavailable right now.'
    );
  },

  getRecommendationsSafe: async (userId) => {
    const result = await requestReco(
      'reco.getRecommendations',
      'get',
      '/recommendations',
      null,
      { params: { userId }, timeout: 8000 },
      'Recommendations are unavailable right now.'
    );

    if (!result.ok) {
      return { ok: false, data: null, error: result.error };
    }

    const body = result.response?.data;
    if (!body?.ok) {
      return { ok: false, data: null, error: body?.error || 'Recommendations unavailable.' };
    }

    return {
      ok: true,
      data: {
        madeForYou: body.madeForYou || [],
        basedOnRecent: body.basedOnRecent || [],
        trending: body.trending || [],
      },
      error: null,
    };
  },
};
