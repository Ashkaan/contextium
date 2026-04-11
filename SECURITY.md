# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.4.x   | Yes       |
| < 1.4   | No        |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

### Preferred: GitHub Private Security Advisory

1. Go to the [Security Advisories](https://github.com/Ashkaan/contextium/security/advisories) page
2. Click **"Report a vulnerability"**
3. Fill in the details and submit

### Alternative: Email

Send details to **ashkaan@strety.com** with subject line `[SECURITY] contextium`.

## What to Include

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment (if known)

## Response Timeline

- **Acknowledge**: within 72 hours
- **Triage**: within 7 days
- **Fix target**: within 30 days for confirmed issues

## Scope

Contextium is a local-first framework with no hosted services. Security scope covers:

- Framework code (templates, agent configs, integrations)
- The installer script (`install.sh`)
- Supply chain concerns (dependencies, external fetches)

Issues in upstream dependencies should be reported to those projects directly.
