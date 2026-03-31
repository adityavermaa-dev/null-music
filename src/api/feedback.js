import axios from 'axios';

import { friendlyErrorMessage, logError } from '../utils/logger';

import { buildApiUrl } from './apiBase';

export const feedbackApi = {
  reportTrackIssue: async ({ token, track, type, note, userId }) => {
    try {
      const response = await axios.post(
        buildApiUrl('/feedback/track-issue'),
        { track, type, note, userId },
        {
          timeout: 10000,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );

      if (!response?.data?.ok) {
        return { ok: false, error: response?.data?.error || 'Could not send issue report.' };
      }

      return { ok: true, error: null };
    } catch (error) {
      logError('feedback.reportTrackIssue', error);
      return {
        ok: false,
        error: friendlyErrorMessage(error, 'Could not send issue report.'),
      };
    }
  },
};
