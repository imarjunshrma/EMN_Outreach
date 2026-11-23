import argon2 from 'argon2';
import QRCode from 'qrcode';
import type { Response } from 'express';
import { db } from '../core/db.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { AppError, BadRequest, Unauthorized } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { redis } from '../core/redis.js';
import { trySendSystemMail, systemMailer } from '../core/mailer.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../core/totp.js';
import { createSession, hashPassword, publicUser, validatePasswordStrength } from './auth.js';
import { decryptSecret, encryptSecret } from './workspace.js';

const RESET_TTL_MS = 60 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

// ------------------------------------------------------------------ password reset by email

/** Always answers the same way whether or not the account exists (no user enumeration). */
export async function requestPasswordReset(email: string, ip?: string) {
  const user = await db().user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (user && user.status === 'ACTIVE') {
    await db().passwordResetToken.updateMany({ where: { userId: user.id, kind: 'RESET', usedAt: null }, data: { usedAt: new Date() } }); // one live token at a time
    const token = randomToken(32);
    await db().passwordResetToken.create({ data: { userId: user.id, kind: 'RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS), ip: ip ?? null } });
    const link = `${process.env.APP_URL}/reset-password/${token}`;
    await trySendSystemMail({ to: user.email, subject: 'Reset your Outvexa password', text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nReset it here (valid for 60 minutes, single use):\n${link}\n\nIf you did not ask for this, ignore this email — your password will not change.` });
    await audit(null, { type: 'USER', userId: user.id, ip }, 'auth.password_reset_requested');
  }
  return { ok: true, message: 'If an account exists for that address, a reset link has been sent.', emailConfigured: systemMailer().configured };
}

export async function resetPassword(token: string, newPassword: string, ip?: string) {
  validatePasswordStrength(newPassword);
  const t = await db().passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!t || t.kind !== 'RESET' || t.usedAt || t.expiresAt < new Date()) throw new AppError('INVALID_TOKEN', 'This reset link is invalid or has expired. Request a new one.', 400);
  const claimed = await db().passwordResetToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!claimed.count) throw new AppError('INVALID_TOKEN', 'This reset link was already used.', 400);
  await db().$transaction([
    db().user.update({ where: { id: t.userId }, data: { passwordHash: await hashPassword(newPassword) } }),
    db().session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  const u = await db().user.findUniqueOrThrow({ where: { id: t.userId } });
  await trySendSystemMail({ to: u.email, subject: 'Your Outvexa password was changed', text: 'Your password was just reset and all sessions were signed out. If this was not you, contact your workspace owner immediately.' });
  await audit(null, { type: 'USER', userId: t.userId, ip }, 'auth.password_reset_completed');
  return { ok: true };
}

// ------------------------------------------------------------------ TOTP two-factor authentication

export async function mfaStatus(userId: string) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
  return { enabled: u.mfaEnabled, enabledAt: u.mfaEnabledAt, recoveryCodesLeft: u.mfaRecoveryHashes.length };
}

/** Step 1: create a pending secret (not active until confirmed with a valid code). */
export async function beginMfaSetup(userId: string) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
  if (u.mfaEnabled) throw new AppError('CONFLICT', 'Two-factor authentication is already enabled', 409);
  const secret = newTotpSecret();
  await db().user.update({ where: { id: userId }, data: { mfaSecretEnc: encryptSecret(secret) } });
  const uri = otpauthUri(secret, u.email);
  return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

async function useCounterOnce(userId: string, counter: number) {
  const ok = await redis().set(`totp:${userId}:${counter}`, '1', 'EX', 120, 'NX');
  return ok === 'OK'; // replay protection: each 30 s code works once
}

/** Step 2: confirm with a code → enable, return recovery codes (shown once). */
export async function enableMfa(userId: string, code: string, actor: Actor) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
  if (u.mfaEnabled) throw new AppError('CONFLICT', 'Already enabled', 409);
  if (!u.mfaSecretEnc) throw BadRequest('VALIDATION_FAILED', 'Start setup first');
  const counter = verifyTotp(decryptSecret(u.mfaSecretEnc), code);
  if (counter === null || !(await useCounterOnce(userId, counter))) throw BadRequest('INVALID_CODE', 'That code is not valid. Check the time on your phone and try again.');
  const recovery = Array.from({ length: 10 }, () => `${randomToken(5).slice(0, 5)}-${randomToken(5).slice(0, 5)}`.toLowerCase());
  await db().user.update({ where: { id: userId }, data: { mfaEnabled: true, mfaEnabledAt: new Date(), mfaRecoveryHashes: recovery.map((r) => sha256(r)) } });
  await audit(null, actor, 'auth.mfa_enabled');
  await trySendSystemMail({ to: u.email, subject: 'Two-factor authentication enabled', text: 'Two-factor authentication is now on for your Outvexa account.' });
  return { enabled: true, recoveryCodes: recovery };
}

export async function disableMfa(userId: string, password: string, code: string, actor: Actor) {
  const u = await db().user.findUniqueOrThrow({ where: { id: userId } });
  if (!u.mfaEnabled) return { enabled: false };
  if (u.platformRole) throw new AppError('FORBIDDEN', 'Platform staff accounts must keep two-factor authentication on. Ask a super admin to remove your platform role first.', 403);
  if (!(await argon2.verify(u.passwordHash, password))) throw BadRequest('INVALID_PASSWORD', 'Password is incorrect');
  if (!(await checkSecondFactor(u, code))) throw BadRequest('INVALID_CODE', 'Invalid authentication or recovery code');
  await db().user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [], mfaEnabledAt: null } });
  await audit(null, actor, 'auth.mfa_disabled');
  await trySendSystemMail({ to: u.email, subject: 'Two-factor authentication disabled', text: 'Two-factor authentication was turned off for your account. If this was not you, reset your password now.' });
  return { enabled: false };
}

async function checkSecondFactor(u: { id: string; mfaSecretEnc: string | null; mfaRecoveryHashes: string[] }, code: string) {
  const c = code.trim().toLowerCase().replace(/\s/g, '');
  if (/^\d{6}$/.test(c) && u.mfaSecretEnc) {
    const counter = verifyTotp(decryptSecret(u.mfaSecretEnc), c);
    return counter !== null && (await useCounterOnce(u.id, counter));
  }
  const h = sha256(c);
  if (u.mfaRecoveryHashes.includes(h)) {
    await db().user.update({ where: { id: u.id }, data: { mfaRecoveryHashes: u.mfaRecoveryHashes.filter((x) => x !== h) } });
    return true;
  }
  return false;
}

/** Called by login when the password was correct but the account has MFA. */
export async function createMfaChallenge(userId: string, ip?: string) {
  const token = randomToken(32);
  await db().passwordResetToken.create({ data: { userId, kind: 'MFA_CHALLENGE', tokenHash: sha256(token), expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS), ip: ip ?? null } });
  return token;
}

export async function completeMfaLogin(res: Response, challenge: string, code: string, meta: { ip?: string; userAgent?: string }) {
  const t = await db().passwordResetToken.findUnique({ where: { tokenHash: sha256(challenge) } });
  if (!t || t.kind !== 'MFA_CHALLENGE' || t.usedAt || t.expiresAt < new Date() || t.attempts >= MAX_ATTEMPTS) throw Unauthorized('Sign-in expired. Enter your password again.');
  await db().passwordResetToken.update({ where: { id: t.id }, data: { attempts: { increment: 1 } } });
  const u = await db().user.findUniqueOrThrow({ where: { id: t.userId } });
  if (!(await checkSecondFactor(u, code))) {
    await audit(null, { type: 'USER', userId: u.id, ip: meta.ip }, 'auth.mfa_failed');
    throw Unauthorized('Invalid authentication code');
  }
  const claimed = await db().passwordResetToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!claimed.count) throw Unauthorized('Sign-in expired. Enter your password again.');
  const membership = await db().workspaceMember.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } });
  const { csrfToken } = await createSession(res, u.id, meta, membership?.workspaceId);
  await db().user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
  await audit(membership?.workspaceId ?? null, { type: 'USER', userId: u.id, ip: meta.ip }, 'auth.login', undefined, { mfa: true });
  return { user: publicUser(u), csrfToken };
}
