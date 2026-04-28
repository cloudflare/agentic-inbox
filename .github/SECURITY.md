# Security Policy

PhishSOC is a security tool. We treat vulnerability reports as a priority.

## Reporting a vulnerability

**Please do not file a public issue for security problems.** Use GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/schmug/PhishSOC/security/advisories) on this repo.
2. Click **Report a vulnerability**.
3. Describe the issue, impact, and a minimum reproduction.

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation within 30 days for high-severity issues.

## Scope

In scope:

- The PhishSOC Worker code in this repository (`app/`, `workers/`, `hub/`, `shared/`)
- Authentication, authorization, and tenant-isolation boundaries
- The phishing-detection pipeline (SPF/DKIM/DMARC parsing, URL/homograph/RDAP analysis, LLM classifier)
- Any configuration in `wrangler.jsonc` that affects security posture

Out of scope:

- Issues in upstream dependencies — please report to the dependency directly; we will pick up fixes via Dependabot
- Issues that require physical access to the operator's Cloudflare account
- Findings that require disabling Cloudflare Access or running outside the documented deployment topology
- Self-XSS, missing security headers without a demonstrated impact, and other low-severity report classes commonly rejected by major bug-bounty programs

## Disclosure

We prefer coordinated disclosure. After a fix ships and operators have had a reasonable window to upgrade, we will publish a GitHub Security Advisory crediting the reporter (unless anonymity is requested).
