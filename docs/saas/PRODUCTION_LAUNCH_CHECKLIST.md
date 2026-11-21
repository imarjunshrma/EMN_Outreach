# Production launch checklist — v1.4.0

Tick each item in staging, then in production. Items marked ★ are launch blockers.

## Infrastructure
- [ ] ★ Staging environment deployed from this release and `/readyz` ok
- [ ] ★ Production `.env` complete; `NODE_ENV=production`; secrets stored outside the repo
- [ ] ★ Separate owner (migration) and runtime database roles
- [ ] TLS on the public hostname; HSTS via nginx config
- [ ] `METRICS_TOKEN` set and Prometheus scraping `/metrics`
- [ ] Alerts from the deployment guide configured
- [ ] ★ Daily backups running, copied off the server, and one restore drill run against a production-sized copy
- [ ] Log rotation (`deployment/logrotate`) installed

## Security
- [ ] ★ Every platform staff account has 2FA enabled (`PLATFORM_MFA_REQUIRED` left on)
- [ ] ★ External penetration test completed and findings resolved
- [ ] Dependency advisories reviewed (3 high backend build-time, 1 high + 1 moderate frontend build-time accepted in v1.4)
- [ ] Secret scan clean on the release commit
- [ ] Session cookie and CSRF settings checked behind the real proxy

## Billing
- [ ] ★ Stripe and/or Razorpay verified end to end in test mode (checkout, renewal, failed payment, refund, dispute)
- [ ] ★ Live keys and webhook secrets installed; price/plan ids on each plan
- [ ] Reconciliation job logs reviewed after the first 24 hours
- [ ] Tax/invoicing requirements for your jurisdictions confirmed

## Email and providers
- [ ] ★ Transactional SMTP verified (verification and reset mails arrive)
- [ ] Google OAuth app verified for restricted scopes (required before public Gmail connections)
- [ ] Microsoft app registration published
- [ ] Cloudflare DNS tested on a throwaway zone

## Legal and content
- [ ] ★ Terms, Privacy Policy and AUP reviewed by a lawyer; "draft" notices removed only after that
- [ ] Contact page details correct; support mailbox monitored
- [ ] Pricing page matches the plan catalogue

## Operations
- [ ] Platform staff trained on suspension, refunds, support access and operations retry
- [ ] Incident contact rota defined
- [ ] Capacity test on production-like hardware (v1.4 load test was single-node, 2 vCPU)
