# Email Template Guide

Conventions for automated email notifications.

## Document Structure

- DOCTYPE + viewport meta
- Outer div (max-width: 640px) + outer table for compatibility
- All CSS inline (Gmail strips style blocks)

## Layout Rules

- Use `<table>`, not `<div>` for structure
- `width="100%"` on tables (not CSS)
- `cellpadding="0" cellspacing="0"` mandatory
- `<td style="padding:...">` for spacing (no margin)

## Color Palette

| Token     | Hex       | Use                     |
| --------- | --------- | ----------------------- |
| Header BG | `#1a1a2e` | Email header background |
| Body BG   | `#f0f0f0` | Email body background   |
| Card BG   | `#ffffff` | Content cards           |
| Border    | `#e0e0e0` | Dividers                |
| Green     | `#2e7d32` | Success, positive       |
| Blue      | `#1565c0` | Info, links             |
| Orange    | `#e65100` | Warning                 |
| Red       | `#c62828` | Error, critical         |

## Typography

| Element       | Size | Weight | Color    |
| ------------- | ---- | ------ | -------- |
| Header title  | 22px | 700    | white    |
| Section title | 16px | 700    | #333     |
| Body          | 14px | 400    | #333     |
| Supporting    | 13px | 400    | #666     |
| Stat numbers  | 28px | 700    | semantic |

Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

## Subject Line Format

Pattern: `[Name] — [Date or Context]`

Examples:

- `Morning Briefing — Saturday, February 8, 2026`
- `Weekly Scorecard — Week 10`
