import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'checkin-agent', version: config.version },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'cookie',
      'cookieSealed',
      'cookie_sealed',
      'password',
      'secret',
      'token',
    ],
    censor: '[redacted]',
  },
});
