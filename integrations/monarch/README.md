# Monarch

Personal finance tracking via Monarch Money for account balances, transactions, budgets, and net worth.

## Requirements

- Monarch Money account (subscription required for API access)
- Login credentials (email + password) or session token
- Python 3.9+ (for the monarchmoney library)

## Setup

1. Install the Python client:
   ```bash
   pip install monarchmoney
   ```
2. Store your Monarch credentials in your vault:
   ```bash
   op item create --category=login --title="Monarch Money" \
     --vault="Finance" username="your@email.com" password="your-password"
   ```
3. Authenticate and get a session token:
   ```python
   from monarchmoney import MonarchMoney
   mm = MonarchMoney()
   await mm.login("your@email.com", "your-password")
   # If MFA is enabled:
   await mm.login("your@email.com", "your-password", mfa_code="123456")
   ```
4. Store the session token in your vault for reuse (avoids repeated MFA prompts)

## Key Operations

```python
from monarchmoney import MonarchMoney

mm = MonarchMoney()
mm.load_session()  # Load saved session

# Account balances and net worth
accounts = await mm.get_accounts()

# Recent transactions (with optional filters)
transactions = await mm.get_transactions(
    start_date="2026-03-01",
    end_date="2026-03-20"
)

# Budget status
budgets = await mm.get_budgets(
    start_date="2026-03-01",
    end_date="2026-03-31"
)

# Cash flow summary
cashflow = await mm.get_cashflow_summary(
    start_date="2026-03-01",
    end_date="2026-03-31"
)

# Net worth over time
net_worth = await mm.get_net_worth()
```

## Key Data

| Data | Method | Use |
|------|--------|-----|
| Account balances | `get_accounts()` | Net worth tracking, balance checks |
| Transactions | `get_transactions()` | Spending review, categorization |
| Budgets | `get_budgets()` | Budget vs. actual comparison |
| Cash flow | `get_cashflow_summary()` | Income and expense trends |
| Net worth | `get_net_worth()` | Long-term wealth tracking |

## Use Cases

- Checking account balances and net worth for weekly reviews
- Reviewing recent transactions and flagging unusual spending
- Tracking budget adherence month-over-month
- Generating personal finance summaries for journal entries
- Pulling cash flow data for financial planning
