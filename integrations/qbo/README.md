# QuickBooks Online

Business accounting via the QuickBooks Online API.

## Requirements

- QuickBooks Online account
- Intuit Developer account with an app
- OAuth2 credentials (client ID + client secret)

## Setup

1. Create an app at developer.intuit.com
2. Configure OAuth2 redirect URI
3. Run the auth flow to get access + refresh tokens
4. Store all credentials in your vault
5. Note your Company ID (realm ID)

## Key Reports

| Report         | Endpoint                 | Use                    |
| -------------- | ------------------------ | ---------------------- |
| Profit & Loss  | `/reports/ProfitAndLoss` | Revenue and expenses   |
| Balance Sheet  | `/reports/BalanceSheet`  | Assets and liabilities |
| General Ledger | `/reports/GeneralLedger` | Transaction detail     |
| Cash Flow      | `/reports/CashFlow`      | Cash movement          |

## Token Management

- Access tokens expire in 1 hour
- Refresh tokens expire in 100 days
- Auto-refresh on each API call
- Re-auth required if refresh token expires

## Use Cases

- Pulling financial reports for review
- Tracking revenue and expense trends
- Generating monthly financial summaries
- Webhook-triggered updates on transactions
