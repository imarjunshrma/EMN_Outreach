export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const NotFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404);
export const Forbidden = (msg = 'You do not have permission to do this') => new AppError('FORBIDDEN', msg, 403);
export const Unauthorized = (msg = 'Authentication required') => new AppError('UNAUTHENTICATED', msg, 401);
export const Conflict = (code: string, msg: string, details?: unknown) => new AppError(code, msg, 409, details);
export const BadRequest = (code: string, msg: string, details?: unknown) => new AppError(code, msg, 400, details);

/** Error codes documented in API_DOCUMENTATION.md */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'Request body, query or params failed validation (400)',
  UNAUTHENTICATED: 'Missing or expired session / API key (401)',
  CSRF_FAILED: 'Missing or wrong X-CSRF-Token header (403)',
  FORBIDDEN: 'Role does not allow this action (403)',
  NOT_FOUND: 'Resource does not exist in this workspace (404)',
  RATE_LIMITED: 'Too many requests (429)',
  CONFLICT: 'Unique constraint or state conflict (409)',
  CAMPAIGN_INVALID: 'Campaign failed validation and cannot be approved/started (400)',
  CAMPAIGN_STATE: 'Action not allowed in the campaign current status (409)',
  PROVIDER_NOT_CONFIGURED: 'Integration / AI provider / OAuth app not configured (400)',
  PROVIDER_ERROR: 'External provider returned an error (502)',
  AI_BUDGET_EXCEEDED: 'Monthly AI budget for this task is used up (402)',
  AI_COST_LIMIT: 'Per-lead AI cost limit would be exceeded (402)',
  QUALITY_CHECK_FAILED: 'Personalization has failing quality checks and cannot be approved (400)',
  AI_OUTPUT_INVALID: 'AI response failed schema validation (502)',
  WEAK_PASSWORD: 'Password does not meet the strength policy (400)',
  INVALID_PASSWORD: 'Current password is wrong (400)',
  REGISTRATION_CLOSED: 'Public registration is disabled; use an invitation (403)',
  LOGIN_REQUIRED: 'Invitation belongs to an existing account; log in first (400)',
  INVITATION_INVALID: 'Invitation token invalid, used or expired (400)',
  INVITATION_EMAIL_MISMATCH: 'Logged-in user is not the invited email (400)',
  LAST_OWNER: 'Cannot remove/demote the last workspace owner (400)',
  OAUTH_STATE_INVALID: 'OAuth state expired, reused or for another provider (400)',
  OAUTH_DENIED: 'User or tenant admin denied consent (400)',
  OAUTH_NO_REFRESH: 'Provider returned no refresh token (400)',
  ACCOUNT_NOT_CONNECTED: 'Mailbox is disconnected / needs re-authentication (400/409)',
  UNRESOLVED_VARIABLES: 'Template still contains unresolved {{variables}} (400)',
  FACT_CHECK_FAILED: 'Independent fact-check found unsupported claims (400)',
  ICP_REQUIRED: 'Scoring needs an ICP first (400)',
  NOT_ELIGIBLE: 'Lead fails a compliance/suppression/verification gate (400)',
  REVIEW_REQUIRED: 'Country rule needs explicit review before enabling (400)',
  INVALID_TOKEN: 'Unsubscribe/booking token invalid (400)',
  MFA_REQUIRED: 'Workspace requires two-factor authentication (403)',
  INVALID_CODE: 'Two-factor code invalid (400)',
  QUOTA_EXCEEDED: 'Plan limit reached for this resource (402)',
  SUBSCRIPTION_INACTIVE: 'Subscription inactive; feature unavailable (402)',
  INVALID_SIGNATURE: 'Webhook signature verification failed (400)',
  TENANT_INACTIVE: 'Organization is suspended, cancelled or being deleted; writes are blocked (403)',
  EMAIL_NOT_VERIFIED: 'Confirm your email address before this action (403)',
  INVALID_TRANSITION: 'Organization status change not allowed from the current status (409)',
  SUPPRESSED: 'Recipient is on the suppression list (400)',
  INTERNAL: 'Unexpected server error (500)',
} as const;
