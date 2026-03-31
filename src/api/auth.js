import axios from 'axios';

import { friendlyErrorMessage, logError } from '../utils/logger';

import { buildApiUrl } from './apiBase';

const authHeaders = (token) => (
  token
    ? { Authorization: `Bearer ${token}` }
    : {}
);

const requestAuth = async (tag, method, path, data, config, fallbackMessage) => {
  try {
    const response = await axios({
      method,
      url: buildApiUrl(path),
      data,
      ...config,
    });
    return {
      ok: true,
      data: response?.data || null,
      error: null,
      status: response?.status || 200,
    };
  } catch (error) {
    logError(tag, error, { path });
    return {
      ok: false,
      data: null,
      error: friendlyErrorMessage(error, fallbackMessage),
      status: error?.response?.status || null,
    };
  }
};

const unwrapAuthBody = (result, fallbackMessage) => {
  if (!result.ok) {
    return result;
  }

  if (!result.data?.ok) {
    return {
      ok: false,
      data: null,
      error: result.data?.error || fallbackMessage,
      status: result.status,
    };
  }

  return {
    ok: true,
    data: result.data,
    error: null,
    status: result.status,
  };
};

export const authApi = {
  signUp: async ({ name, email, password }) => {
    const result = await requestAuth(
      'auth.signUp',
      'post',
      '/auth/signup',
      { name, email, password },
      { timeout: 10000 },
      'Sign up is unavailable right now.'
    );
    return unwrapAuthBody(result, 'Unable to create your account right now.');
  },

  login: async ({ email, password }) => {
    const result = await requestAuth(
      'auth.login',
      'post',
      '/auth/login',
      { email, password },
      { timeout: 10000 },
      'Login is unavailable right now.'
    );
    return unwrapAuthBody(result, 'Unable to sign in right now.');
  },

  sendPhoneOtp: async ({ phone }) => {
    const result = await requestAuth(
      'auth.phone.sendOtp',
      'post',
      '/auth/phone/send-otp',
      { phone },
      { timeout: 15000 },
      'Phone OTP is unavailable right now.'
    );
    return unwrapAuthBody(result, 'Phone OTP is unavailable right now.');
  },

  verifyPhoneOtp: async ({ phone, code, name }) => {
    const result = await requestAuth(
      'auth.phone.verifyOtp',
      'post',
      '/auth/phone/verify-otp',
      { phone, code, name },
      { timeout: 15000 },
      'OTP verification failed.'
    );
    return unwrapAuthBody(result, 'OTP verification failed.');
  },

  getCurrentUser: async (token) => {
    const result = await requestAuth(
      'auth.me',
      'get',
      '/auth/me',
      null,
      { headers: authHeaders(token), timeout: 8000 },
      'Could not verify your session.'
    );
    return unwrapAuthBody(result, 'Could not verify your session.');
  },

  getLibrary: async (token) => {
    const result = await requestAuth(
      'auth.library.get',
      'get',
      '/library',
      null,
      { headers: authHeaders(token), timeout: 10000 },
      'Could not load your library.'
    );
    return unwrapAuthBody(result, 'Could not load your library.');
  },

  saveLibrary: async (token, library) => {
    const result = await requestAuth(
      'auth.library.save',
      'put',
      '/library',
      library,
      { headers: authHeaders(token), timeout: 12000 },
      'Could not save your library.'
    );
    return unwrapAuthBody(result, 'Could not save your library.');
  },

  changePassword: async (token, { currentPassword, newPassword }) => {
    const result = await requestAuth(
      'auth.changePassword',
      'post',
      '/auth/change-password',
      { currentPassword, newPassword },
      { headers: authHeaders(token), timeout: 12000 },
      'Could not update your password.'
    );
    return unwrapAuthBody(result, 'Could not update your password.');
  },
};
