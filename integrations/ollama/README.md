# Ollama

Local AI inference for private, offline, cost-free tasks. Runs open-source models (Llama 3, Mistral, CodeLlama, etc.) entirely on your machine. Used as a primary agent or delegated sub-agent when privacy, cost, or offline access matters.

## Requirements

- 8GB+ RAM (16GB recommended for larger models)
- Ollama installed (macOS, Linux, or WSL)
- Disk space for model weights (~4GB for 8B models, ~26GB for 70B)

## Setup

1. Install Ollama:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```
2. Pull a model:
   ```bash
   ollama pull llama3.1
   ```
3. (Optional) Create a Contextium-configured model:
   ```bash
   ollama create contextium -f Modelfile
   ```
4. Verify: `ollama run llama3.1 "Hello, what can you help me with?"`

## When to Delegate to Ollama

| Scenario | Why Ollama |
|----------|-----------|
| Privacy-sensitive tasks | Data never leaves your machine |
| Offline work | No internet required |
| Cost-free inference | No API keys or billing |
| Brainstorming / drafts | Fast iteration without token spend |
| Sensitive document review | No data sent to cloud providers |

**Do NOT delegate** for tasks requiring file system access, tool use, web research, or multi-file code edits — Ollama models lack these capabilities.

## Key Commands

```bash
# Interactive chat
ollama run llama3.1

# Chat with Contextium system prompt baked in
ollama run contextium

# Single query (non-interactive)
echo "Summarize the key points of this decision" | ollama run llama3.1

# List installed models
ollama list

# Pull a coding-focused model
ollama pull qwen2.5-coder

# API endpoint (for automation)
curl http://localhost:11434/api/generate -d '{"model":"llama3.1","prompt":"Hello"}'
```

## Model Recommendations

| Use Case | Model | Size |
|----------|-------|------|
| General assistant | `llama3.1` | ~4.7GB |
| Code generation | `qwen2.5-coder` | ~4.7GB |
| Fast / low RAM | `llama3.2:3b` | ~2GB |
| Maximum quality | `llama3.1:70b` | ~26GB |

## Limitations

Ollama models run locally and do NOT have:
- File system access (cannot read/write files)
- Tool use (cannot run commands or call APIs)
- Git operations (cannot commit, push, or journal)
- Web access (cannot browse URLs or search)

Users must handle file operations, git, and journaling manually when using Ollama as a primary agent.

## Use Cases

- Drafting content privately before sharing with cloud AI for refinement
- Brainstorming and ideation without cost concerns
- Reviewing sensitive documents locally
- Working offline (travel, air-gapped environments)
- Reducing cloud AI spend on low-complexity tasks
