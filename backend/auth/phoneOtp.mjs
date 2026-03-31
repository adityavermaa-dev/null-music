const TWILIO_VERIFY_BASE = "https://verify.twilio.com/v2";

function getTwilioConfig() {
  return {
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
    serviceSid: String(process.env.TWILIO_VERIFY_SERVICE_SID || "").trim(),
  };
}

function getAuthHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[^\d+]/g, "");
  if (compact.startsWith("00")) return `+${compact.slice(2)}`;
  if (compact.startsWith("+")) return `+${compact.slice(1).replace(/\D/g, "")}`;
  return compact.replace(/\D/g, "") ? `+${compact.replace(/\D/g, "")}` : "";
}

function assertConfigured() {
  const { accountSid, authToken, serviceSid } = getTwilioConfig();
  if (!accountSid || !authToken || !serviceSid) {
    const error = new Error("Phone OTP is not configured on the server.");
    error.status = 501;
    throw error;
  }
  return { accountSid, authToken, serviceSid };
}

async function postTwilioForm(path, body) {
  const { accountSid, authToken } = assertConfigured();
  const response = await fetch(`${TWILIO_VERIFY_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(accountSid, authToken),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || `Twilio Verify failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

export function normalizePhoneNumber(value) {
  return normalizePhone(value);
}

export async function sendPhoneOtp(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!/^\+\d{8,15}$/.test(normalizedPhone)) {
    const error = new Error("Enter a valid phone number in international format.");
    error.status = 400;
    throw error;
  }

  const { serviceSid } = assertConfigured();
  const data = await postTwilioForm(`/Services/${serviceSid}/Verifications`, {
    To: normalizedPhone,
    Channel: "sms",
  });

  return {
    phone: normalizedPhone,
    status: String(data?.status || "pending"),
  };
}

export async function verifyPhoneOtpCode(phone, code) {
  const normalizedPhone = normalizePhone(phone);
  const normalizedCode = String(code || "").trim();

  if (!/^\+\d{8,15}$/.test(normalizedPhone)) {
    const error = new Error("Enter a valid phone number in international format.");
    error.status = 400;
    throw error;
  }

  if (!/^\d{4,10}$/.test(normalizedCode)) {
    const error = new Error("Enter a valid OTP code.");
    error.status = 400;
    throw error;
  }

  const { serviceSid } = assertConfigured();
  const data = await postTwilioForm(`/Services/${serviceSid}/VerificationCheck`, {
    To: normalizedPhone,
    Code: normalizedCode,
  });

  if (String(data?.status || "").toLowerCase() !== "approved") {
    const error = new Error("OTP verification failed.");
    error.status = 401;
    throw error;
  }

  return {
    phone: normalizedPhone,
    status: "approved",
  };
}
