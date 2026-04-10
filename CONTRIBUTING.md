# Contributing to Contextium

Thank you for your interest in contributing to Contextium. This document explains how to add new apps, integrations, and
improvements.

## Types of Contributions

### New App

Apps are self-contained protocols with optional automation scripts. To add one:

1. Create `apps/{name}/README.md` following the [app template](preferences/templates/app-readme.md)
2. Include:
   - YAML frontmatter (name, description, category, schedule, runtime, trigger)
   - What the app does
   - How it works (protocol/steps)
   - What integrations it needs
   - Pattern label (Timer, Data Sync, System/Event, Reference, Utility, Briefing)
3. Add your app to `apps/README.md`
4. Submit a PR using the "New App" issue template

### New Integration

Integrations connect external services. To add one:

1. Create `integrations/{name}/README.md`
2. Include:
   - What the service does
   - Requirements (accounts, API keys, CLI tools)
   - Setup steps
   - Key endpoints or commands
   - Common use cases within Contextium
3. Add to `integrations/README.md` quick reference table
4. Submit a PR

### Documentation Improvements

- Fix typos, clarify instructions, add examples
- Update outdated information
- Improve the onboarding guide

### Framework Improvements

- Enhancements to CLAUDE.md, rules, or templates
- New app templates in `templates/apps/`
- CI workflow improvements

## Pull Request Process

1. Fork the repo
2. Create a feature branch: `git checkout -b add-{name}-app`
3. Make your changes
4. Ensure no PII (personal names, emails, IPs, API keys) is included
5. Submit a PR using the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

## Code of Conduct

- Be respectful and constructive
- Focus on the framework, not personal configurations
- Never include credentials, tokens, or personal data
- Test your additions with a fresh clone when possible

## Questions?

Open an issue with the "question" label.
