---
name: Shared Utilities
description: >-
  Reusable utility functions used across automations: notifications, email sending, HTTP helpers.
category: system
schedule: Library
runtime: Your automation platform
trigger: Called by other apps
outputs:
  - Email via webhook
integrations:
  - Gmail or SMTP
---

# Shared Utilities

Reusable notification and email functions used by other apps.

## Pattern: Utility

This app is a library — it doesn't run on a schedule. Other apps call its functions.

## Notification Service

A webhook-based notification service that sends styled HTML emails:

- **Escalation** (red): issues needing user action
- **Fix** (green): auto-resolved issues
- **Info** (dark): general notifications

## Implementation

Set up a webhook endpoint in your automation platform that:

1. Accepts a JSON payload with `type`, `source`, `subject`, and `message`
2. Formats a styled HTML email using the [email template guide](../../preferences/style_guides/email_templates.md)
3. Sends via Gmail API or SMTP
