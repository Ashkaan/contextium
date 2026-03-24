# People Directory

Persistent context about the people in your life.

## Structure

Each person gets a directory: `knowledge/people/{firstname-lastname}/`

At minimum, create a `README.md`:

```markdown
**Relationship:** friend | colleague | family | partner | client **Added:** YYYY-MM-DD **Birthday:** MM-DD (optional)
**Location:** City, State (optional)

## Notes

- [preference] How they like to communicate
- [work] What they do professionally
- [family] Family context
- [gift] Gift ideas or favorites
- [connection] How you know them
- [contact] Phone, email (if relevant)
```

## Important People

For people central to your life (partner, close family, business partners), create richer directories:

```
knowledge/people/{name}/
├── README.md       # Basic info
├── goals.md        # Their goals (if shared)
├── health.md       # Health context (if relevant)
└── vision.md       # Shared vision or plans
```

## Tips

- Create cards as people come up naturally in conversation
- Your AI will suggest creating cards when you mention someone new
- Update cards when you learn something worth remembering
- Tags in brackets help categorize information: [preference], [work], [family], [gift], [avoid], [connection]
