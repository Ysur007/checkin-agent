import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db } from './db/index.js';
import {
  cleanupSessions,
  createSession,
  deleteSession,
  getAuthSetting,
  getSessionByHash,
  setAuthSetting,
  touchSession,
} from './db/repo.js';
import { sha256 } from './crypto/redact.js';
import type { SessionRow } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRow;
  }
}

const SESSION_COOKIE = 'ca_session';
const CSRF_COOKIE = 'ca_csrf';

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export function verifyPassword(password: string, stored: { salt: string; hash: string }): boolean {
  try {
    const salt = Buffer.from(stored.salt, 'base64');
    const expected = Buffer.from(stored.hash, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function setupRequired(): boolean {
  return getAuthSetting() === null;
}

export function startSession(request: FastifyRequest, reply: FastifyReply): void {
  cleanupSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);

  createSession(sha256(token), sha256(csrf), expires.toISOString(), request.ip ?? null, request.headers['user-agent'] ?? null);

  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires,
  });
  reply.setCookie(CSRF_COOKIE, csrf, {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires,
  });
}

export function endSession(request: FastifyRequest, reply: FastifyReply): void {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    const session = getSessionByHash(sha256(token));
    if (session) deleteSession(session.id);
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export function readSession(request: FastifyRequest): SessionRow | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = getSessionByHash(sha256(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    deleteSession(session.id);
    return null;
  }
  touchSession(session.id);
  return session;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = readSession(request);
  if (!session) {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
    return;
  }
  request.session = session;
}

export async function requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const session = request.session ?? readSession(request);
  if (!session) {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
    return;
  }
  const header = String(request.headers['x-csrf-token'] ?? '');
  const cookie = String(request.cookies[CSRF_COOKIE] ?? '');
  if (!header || !cookie || header !== cookie || sha256(header) !== session.csrf_hash) {
    reply.code(403).send({ error: { code: 'CSRF_INVALID', message: '页面凭证已失效，请刷新后重试' } });
  }
}

export function savePassword(password: string): void {
  setAuthSetting(hashPassword(password));
}

export function ensureEnvPassword(): void {
  if (!setupRequired()) return;
  if (!config.adminPassword) return;
  savePassword(config.adminPassword);
}
