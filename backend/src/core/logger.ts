import pino from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]',
  '*.password', '*.passwordHash', '*.apiKey', '*.accessToken', '*.refreshToken', '*.token', '*.secret',
  '*.encryptedApiKey', '*.encryptedAccessToken', '*.encryptedRefreshToken', '*.encryptedPassword', '*.encryptedConfig',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: process.env.EMN_SERVICE ?? 'emn' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
