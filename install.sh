#!/usr/bin/env bash
set -euo pipefail

# Contextium Installer
# Usage:
#   Fresh install: curl -sSL contextium.ai/install | bash
#   Update:        ./install.sh update

REPO="https://github.com/Ashkaan/contextium.git"
VERSION="v2.0.0"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# Gum theming — brand color #00b4d8 (teal/cyan)
export GUM_CHOOSE_CURSOR_FOREGROUND="#00b4d8"
export GUM_CHOOSE_SELECTED_FOREGROUND="#00b4d8"
export GUM_CHOOSE_HEADER_FOREGROUND="#00b4d8"
export GUM_INPUT_CURSOR_FOREGROUND="#00b4d8"
export GUM_INPUT_PROMPT_FOREGROUND="#00b4d8"
export GUM_CONFIRM_SELECTED_FOREGROUND="#00b4d8"

banner() {
  echo ""
  echo -e "${BLUE}┌─────────────────────────────────────────┐${NC}"
  echo -e "${BLUE}│         ${CYAN}Contextium${BLUE}                      │${NC}"
  echo -e "${BLUE}│    Give your AI an operating system     │${NC}"
  echo -e "${BLUE}│              ${DIM}${VERSION}${NC}${BLUE}                     │${NC}"
  echo -e "${BLUE}└─────────────────────────────────────────┘${NC}"
  echo ""
}

# --- Dependency check ---

ensure_gum() {
  if command -v gum &>/dev/null; then
    return 0
  fi

  echo -e "${BLUE}Installing gum (interactive UI toolkit)...${NC}"

  # Detect OS and install
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      brew install gum 2>/dev/null
    else
      echo -e "${YELLOW}Please install Homebrew first: https://brew.sh${NC}" >&2
      exit 1
    fi
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get &>/dev/null; then
      sudo mkdir -p /etc/apt/keyrings
      curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/charm.gpg 2>/dev/null
      echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list >/dev/null
      sudo apt-get update -qq -o Dir::Etc::sourcelist="sources.list.d/charm.list" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" && sudo apt-get install -y -qq gum >/dev/null 2>&1
    elif command -v yum &>/dev/null; then
      echo '[charm]
name=Charm
baseurl=https://repo.charm.sh/yum/
enabled=1
gpgcheck=1
gpgkey=https://repo.charm.sh/yum/gpg.key' | sudo tee /etc/yum.repos.d/charm.repo >/dev/null
      sudo yum install -y gum >/dev/null 2>&1
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm gum >/dev/null 2>&1
    else
      echo -e "${YELLOW}Could not auto-install gum. Install manually: https://github.com/charmbracelet/gum${NC}" >&2
      exit 1
    fi
  else
    echo -e "${YELLOW}Unsupported OS. Install gum manually: https://github.com/charmbracelet/gum${NC}" >&2
    exit 1
  fi

  if ! command -v gum &>/dev/null; then
    echo -e "${YELLOW}Failed to install gum. Install manually: https://github.com/charmbracelet/gum${NC}" >&2
    exit 1
  fi
  echo -e "${GREEN}gum installed.${NC}"
}

ensure_prerequisites() {
  local missing=0

  if ! command -v git &>/dev/null; then
    echo -e "${YELLOW}git is required but not installed.${NC}" >&2
    echo -e "  macOS: ${BOLD}xcode-select --install${NC}"
    echo -e "  Linux: ${BOLD}sudo apt install git${NC} or ${BOLD}sudo yum install git${NC}"
    missing=1
  fi

  if ! command -v npm &>/dev/null; then
    echo -e "${DIM}npm not found — some AI agents (Claude Code, Codex, Gemini) need it for install.${NC}"
    echo -e "${DIM}You can install Node.js from https://nodejs.org if needed.${NC}"
  fi

  if [[ $missing -eq 1 ]]; then
    echo ""
    echo -e "${YELLOW}Install the missing prerequisites and run again.${NC}" >&2
    exit 1
  fi
}

# --- Shared helpers ---

# Create a user profile in knowledge/people/
# Args: $1=name, $2=name_lower, $3=profession, $4=ai_goal
create_profile() {
  mkdir -p "knowledge/people/${2}"
  cat > "knowledge/people/${2}/README.md" << PROFILE_EOF
# ${1}

**Added:** $(date +%Y-%m-%d)

## About

${3}

## AI Goal

${4}
PROFILE_EOF
  echo -e "  ${GREEN}✓${NC} Profile created for ${1}"
}

# Write preferences file
# Args: $1=user_name, $2=comm_short, $3=profession, $4=ai_goal, $5=autonomy_short, $6=work_style_short
write_preferences() {
  cat > preferences/user/preferences.md << PREFS_EOF
# User Preferences — ${1}

## Communication

$(case "$2" in
  concise)
    echo "- **Concise over verbose** — get to the point"
    echo "- **Direct over diplomatic** — say what you mean"
    echo "- **Practical over theoretical** — focus on what works"
    ;;
  balanced)
    echo "- **Brief but reasoned** — include the why, skip the filler"
    echo "- **Direct but thoughtful** — explain trade-offs when relevant"
    echo "- **Practical first** — theory only when it informs action"
    ;;
  thorough)
    echo "- **Thorough explanations** — show your reasoning"
    echo "- **Present alternatives** — help me think through options"
    echo "- **Context-rich** — include background when it helps"
    ;;
esac)

## Professional Context

${3}

## Primary Goal with AI

${4}

## Autonomy

$(case "$5" in
  cautious)
    echo "- **Always ask before acting** — present your plan first"
    echo "- **No side effects without approval** — confirm before creating, deleting, or sending"
    ;;
  balanced)
    echo "- **Act on routine tasks** — file edits, lookups, formatting"
    echo "- **Ask on big decisions** — destructive actions, external calls, architectural changes"
    ;;
  autonomous)
    echo "- **Act directly** — create files, edit code, run builds, commit changes"
    echo "- **Only ask when stuck** — ambiguous tasks, destructive operations, or blocked"
    ;;
esac)

## Work Style

$(case "$6" in
  solo)
    echo "- **Solo operator** — optimize for individual productivity"
    ;;
  team)
    echo "- **Team player** — consider collaboration, communication, and shared context"
    ;;
esac)

## Working Style

*Update this as your AI learns how you work best.*
PREFS_EOF
  echo -e "  ${GREEN}✓${NC} Preferences configured (${2} communication, ${5} autonomy)"
}

# Apply autonomy mode to behavior.md
# Args: $1=autonomy_short
apply_autonomy_mode() {
  local behavior_file="preferences/rules/behavior.md"
  if [[ ! -f "$behavior_file" ]]; then
    return
  fi

  # Remove any existing autonomy section before appending (idempotent)
  sed -i '/^## Cautious Mode$/,/^$/d' "$behavior_file" 2>/dev/null
  sed -i '/^## Autonomous Mode$/,/^$/d' "$behavior_file" 2>/dev/null

  case "$1" in
    cautious)
      cat >> "$behavior_file" << 'CAUTIOUS_EOF'

## Cautious Mode

Always ask the user before: creating files, running commands, making commits, sending anything externally. Present your plan first.
CAUTIOUS_EOF
      echo -e "  ${GREEN}✓${NC} Behavior set to cautious mode"
      ;;
    balanced)
      # behavior.md is already balanced by default — no changes needed
      echo -e "  ${GREEN}✓${NC} Behavior set to balanced mode (default)"
      ;;
    autonomous)
      cat >> "$behavior_file" << 'AUTONOMOUS_EOF'

## Autonomous Mode

Act directly on routine tasks: create files, edit code, run builds, commit changes. Only ask when: the task is ambiguous, you're about to do something destructive, or you're stuck.
AUTONOMOUS_EOF
      echo -e "  ${GREEN}✓${NC} Behavior set to autonomous mode"
      ;;
  esac
}

# --- Init (fresh install) ---

init() {
  banner
  ensure_gum
  ensure_prerequisites

  # Step 1: Name
  echo -e "${BOLD}What's your name?${NC}"
  echo -e "${DIM}So your AI recognizes you across sessions and never has to ask again.${NC}"
  USER_NAME=$(gum input --prompt "" --placeholder "Your name" --width 40)
  if [[ -z "$USER_NAME" ]]; then
    echo -e "${YELLOW}Name is required.${NC}" >&2
    exit 1
  fi
  echo ""

  # Step 2: Directory
  echo -e "${BOLD}Where should we set up your Contextium?${NC}"
  echo -e "${DIM}Everything lives in one folder — your AI reads and writes here across sessions.${NC}"
  DIR_NAME=$(gum input --prompt "" --placeholder "my-context" --value "my-context" --width 40)
  DIR_NAME="${DIR_NAME:-my-context}"
  if [[ -d "$DIR_NAME" ]]; then
    echo -e "${YELLOW}Directory '$DIR_NAME' already exists. Use './install.sh update' inside it to update.${NC}" >&2
    exit 1
  fi
  echo ""

  # Step 3: AI Agent
  echo -e "${BOLD}Which AI coding agent do you use?${NC}"
  echo -e "${DIM}Different agents need different instruction files. We'll configure yours${NC}"
  echo -e "${DIM}so it knows how to navigate your Contextium from the first session.${NC}"
  AI_AGENT=$(gum choose --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "Claude Code (recommended)" \
    "Gemini CLI" \
    "Codex CLI" \
    "Cursor" \
    "Windsurf" \
    "Cline" \
    "Aider" \
    "Continue" \
    "GitHub Copilot" \
    "Ollama (local)" \
    "Other")
  echo -e "${DIM}Selected: ${AI_AGENT}${NC}"
  echo ""

  # Step 4: About You
  echo -e "${BOLD}Tell us about yourself${NC}"
  echo -e "${DIM}This shapes how your AI communicates and what it focuses on.${NC}"
  echo ""

  COMM_STYLE=$(gum choose \
    "Concise — get to the point, no filler" \
    "Balanced — clear and detailed when needed" \
    "Thorough — explain reasoning, show your work")
  echo ""

  echo -e "${BOLD}What do you do? (one line is fine)${NC}"
  echo -e "${DIM}So your AI understands your professional context and can give relevant advice.${NC}"
  PROFESSION=$(gum input --prompt "> " --placeholder "Software engineer, MSP owner, freelance designer..." --width 60)
  echo ""

  echo -e "${BOLD}What's the #1 thing you want AI to help with?${NC}"
  echo -e "${DIM}This becomes your AI's north star — it'll prioritize suggestions around this.${NC}"
  AI_GOAL=$(gum input --prompt "> " --placeholder "Ship code faster, manage my business, organize my life..." --width 60)
  echo ""

  # Step 5: How should your AI operate?
  echo -e "${BOLD}How should your AI operate?${NC}"
  echo -e "${DIM}This shapes guardrails and how independently your AI acts.${NC}"
  echo ""

  AUTONOMY=$(gum choose \
    "Cautious — always ask before acting" \
    "Balanced — act on routine tasks, ask on big decisions" \
    "Autonomous — act and report, only ask when stuck")
  echo ""

  WORK_STYLE=$(gum choose \
    "Solo — just me" \
    "Team — I work with others")
  echo ""

  # Step 6: Private GitHub repo
  CREATE_REPO="no"
  echo -e "${BOLD}Want to back up your Contextium to GitHub?${NC}"
  echo -e "${DIM}Your context compounds over time — losing it means starting over.${NC}"
  echo -e "${DIM}A private GitHub repo keeps it backed up and synced across machines.${NC}"
  CREATE_REPO=$(gum choose "Yes — create private repo and push" "No — keep it local for now")

  if [[ "$CREATE_REPO" == "Yes"* ]]; then
    # Ensure gh is installed
    if ! command -v gh &>/dev/null; then
      echo -e "${BLUE}Installing GitHub CLI...${NC}"
      if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install gh 2>/dev/null || { echo -e "${YELLOW}Could not install gh. Install manually: https://cli.github.com${NC}" >&2; CREATE_REPO="no"; }
      elif command -v apt-get &>/dev/null; then
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
        sudo apt-get update -qq -o Dir::Etc::sourcelist="sources.list.d/github-cli.list" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" && sudo apt-get install -y -qq gh >/dev/null 2>&1
        echo -e "  ${GREEN}✓${NC} GitHub CLI installed"
      else
        echo -e "${YELLOW}Could not install gh. Install manually: https://cli.github.com${NC}" >&2
        CREATE_REPO="no"
      fi
    fi

    # Ensure gh is authenticated
    if [[ "$CREATE_REPO" == "Yes"* ]] && command -v gh &>/dev/null; then
      if ! gh auth status &>/dev/null 2>&1; then
        echo ""
        echo -e "${BLUE}┌─────────────────────────────────────────┐${NC}"
        echo -e "${BLUE}│  ${BOLD}Let's connect to GitHub${NC}${BLUE}                │${NC}"
        echo -e "${BLUE}│                                         │${NC}"
        echo -e "${BLUE}│  ${NC}1. A code will appear below${BLUE}             │${NC}"
        echo -e "${BLUE}│  ${NC}2. Go to: ${BOLD}github.com/login/device${NC}${BLUE}     │${NC}"
        echo -e "${BLUE}│  ${NC}3. Paste the code and authorize${BLUE}         │${NC}"
        echo -e "${BLUE}└─────────────────────────────────────────┘${NC}"
        echo ""

        # Generate QR code for the device URL if qrencode is available
        if command -v qrencode &>/dev/null; then
          qrencode -t UTF8 -m 2 "https://github.com/login/device" 2>/dev/null
          echo -e "${DIM}  Or scan the QR code above on your phone.${NC}"
          echo ""
        fi

        gh auth login --git-protocol https --web 2>&1 || {
          echo ""
          echo -e "${YELLOW}GitHub auth didn't complete. No worries — you can do this later:${NC}" >&2
          echo -e "  ${BOLD}gh auth login${NC}"
          echo -e "  ${BOLD}gh repo create $(basename "$(pwd)") --private --source=. --push${NC}"
          CREATE_REPO="no"
        }
        # Configure git to use gh as credential helper (required for push)
        if gh auth status &>/dev/null; then
          gh auth setup-git 2>/dev/null || true
        fi
      fi
    fi
  fi
  echo ""

  # --- Execute ---

  echo -e "${BLUE}Setting up your Contextium...${NC}"
  echo ""

  # Clone template (keep history for upstream merges to work)
  if ! git clone "$REPO" "$DIR_NAME" 2>&1 | tail -1; then
    echo -e "${YELLOW}Failed to clone the Contextium template. Check your internet connection.${NC}" >&2
    exit 1
  fi
  cd "$DIR_NAME" || { echo -e "${YELLOW}Failed to enter directory '$DIR_NAME'.${NC}" >&2; exit 1; }

  # Rename origin to upstream (framework source for future updates)
  git remote rename origin upstream

  # Copy agent config to the correct filename for the selected agent.
  # Each agent has its own instruction file in agent-configs/ with the same core
  # content (context router, rules, structure) formatted for that agent's conventions.
  case "$AI_AGENT" in
    "Claude Code"*)
      cp "agent-configs/claude/CLAUDE.md" ./CLAUDE.md
      echo -e "  ${GREEN}✓${NC} Installed → CLAUDE.md"
      ;;
    "Gemini"*)
      cp "agent-configs/gemini/GEMINI.md" ./GEMINI.md
      echo -e "  ${GREEN}✓${NC} Installed → GEMINI.md"
      ;;
    "Codex"*)
      cp "agent-configs/codex/AGENTS.md" ./AGENTS.md
      echo -e "  ${GREEN}✓${NC} Installed → AGENTS.md"
      ;;
    "Cursor"*)
      cp "agent-configs/cursor/.cursorrules" ./.cursorrules
      echo -e "  ${GREEN}✓${NC} Installed → .cursorrules"
      ;;
    "Windsurf"*)
      cp "agent-configs/windsurf/.windsurfrules" ./.windsurfrules
      echo -e "  ${GREEN}✓${NC} Installed → .windsurfrules"
      ;;
    "Cline"*)
      cp "agent-configs/cline/.clinerules" ./.clinerules
      echo -e "  ${GREEN}✓${NC} Installed → .clinerules"
      ;;
    "Aider"*)
      cp "agent-configs/aider/CONVENTIONS.md" ./CONVENTIONS.md
      echo -e "  ${GREEN}✓${NC} Installed → CONVENTIONS.md"
      ;;
    "Continue"*)
      mkdir -p .continue
      cp "agent-configs/continue/rules" ./.continue/rules
      echo -e "  ${GREEN}✓${NC} Installed → .continue/rules"
      ;;
    "GitHub Copilot"*)
      mkdir -p .github
      cp "agent-configs/copilot/copilot-instructions.md" ./.github/copilot-instructions.md
      echo -e "  ${GREEN}✓${NC} Installed → .github/copilot-instructions.md"
      ;;
    "Ollama"*)
      echo -e "${DIM}Which Ollama model do you want to use?${NC}"
      OLLAMA_MODEL=$(gum input --prompt "" --placeholder "llama3.1" --value "llama3.1" --width 40)
      OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.1}"
      sed "s/^FROM .*/FROM ${OLLAMA_MODEL}/" "agent-configs/ollama/Modelfile" > ./Modelfile
      echo -e "  ${GREEN}✓${NC} Installed → Modelfile (model: ${OLLAMA_MODEL})"
      cp "agent-configs/claude/CLAUDE.md" ./CLAUDE.md
      echo -e "  ${DIM}Also created CLAUDE.md for reference (Ollama reads from Modelfile)${NC}"
      ;;
    "Other"*)
      cp "agent-configs/claude/CLAUDE.md" ./CLAUDE.md
      echo -e "  ${GREEN}✓${NC} Installed → CLAUDE.md (universal default)"
      echo -e "  ${DIM}Rename to match your agent's instruction file format if needed.${NC}"
      ;;
  esac

  # Clean up — remove upstream project files that users don't need
  rm -rf agent-configs          # Agent config already copied to root
  rm -rf .github                # CI, issue templates — upstream only
  rm -f CHANGELOG.md            # Upstream changelog
  rm -f CONTRIBUTING.md         # Upstream contributor guide

  # Replace marketing README with a personal one
  cat > README.md << 'PERSONALREADME'
# My Contextium

Personal AI context repo. Powered by [Contextium](https://contextium.ai).

## Quick Reference

| Directory | Purpose |
|-----------|---------|
| `apps/` | App protocols and automation scripts |
| `knowledge/` | Domain-organized reference data |
| `projects/` | Time-boxed work items |
| `journal/` | Daily session logs |
| `preferences/` | Your preferences, rules, templates |
| `integrations/` | External service connectors |

## Update

```bash
./install.sh update
```
PERSONALREADME

  echo -e "  ${GREEN}✓${NC} Cleaned up upstream files"

  # Remove the starter CLAUDE.md if a different agent was selected
  if [[ "$AI_AGENT" != "Claude Code"* && "$AI_AGENT" != "Other"* && "$AI_AGENT" != "Ollama"* ]]; then
    rm -f CLAUDE.md
  fi

  # Create user profile
  USER_NAME_LOWER=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  create_profile "$USER_NAME" "$USER_NAME_LOWER" "$PROFESSION" "$AI_GOAL"

  # Derive short values for preferences
  COMM_SHORT=""
  case "$COMM_STYLE" in
    "Concise"*)  COMM_SHORT="concise" ;;
    "Balanced"*) COMM_SHORT="balanced" ;;
    "Thorough"*) COMM_SHORT="thorough" ;;
  esac

  AUTONOMY_SHORT=""
  case "$AUTONOMY" in
    "Cautious"*)   AUTONOMY_SHORT="cautious" ;;
    "Balanced"*)   AUTONOMY_SHORT="balanced" ;;
    "Autonomous"*) AUTONOMY_SHORT="autonomous" ;;
  esac

  WORK_STYLE_SHORT=""
  case "$WORK_STYLE" in
    "Solo"*) WORK_STYLE_SHORT="solo" ;;
    "Team"*) WORK_STYLE_SHORT="team" ;;
  esac

  # Write full preferences file
  write_preferences "$USER_NAME" "$COMM_SHORT" "$PROFESSION" "$AI_GOAL" "$AUTONOMY_SHORT" "$WORK_STYLE_SHORT"

  # Apply autonomy mode to behavior.md
  apply_autonomy_mode "$AUTONOMY_SHORT"

  # Set git identity if not configured (uses name from onboarding)
  if ! git config user.name &>/dev/null; then
    git config user.name "${USER_NAME}"
  fi
  if ! git config user.email &>/dev/null; then
    git config user.email "contextium@localhost"
  fi

  # Git commit
  git add -A
  git commit -q -m "Initial Contextium setup for ${USER_NAME} (${VERSION})"

  # Upstream remote already set from clone rename
  git config merge.ours.driver true

  # Create private GitHub repo if requested
  if [[ "$CREATE_REPO" == "Yes"* ]]; then
    echo ""
    GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")
    if [[ -n "$GITHUB_USER" ]]; then
      DEFAULT_REPO=$(basename "$(pwd)")
      echo -e "${BOLD}What should the GitHub repo be called?${NC}"
      echo -e "${DIM}This will be private at github.com/${GITHUB_USER}/...${NC}"
      REPO_NAME=$(gum input --prompt "" --placeholder "$DEFAULT_REPO" --value "$DEFAULT_REPO" --width 40)
      REPO_NAME="${REPO_NAME:-$DEFAULT_REPO}"
      echo ""
      echo -e "${BLUE}Creating private GitHub repo...${NC}"
      # Detect Codespace token limitations
      if [[ -n "${CODESPACES:-}" ]]; then
        echo -e "  ${YELLOW}GitHub Codespaces uses a restricted token that can't create repos.${NC}" >&2
        echo -e "  ${DIM}No worries — once you install Contextium on your real machine,${NC}"
        echo -e "  ${DIM}open your AI and say:${NC}"
        echo ""
        echo -e "  ${GREEN}\"Create a private GitHub repo for my Contextium and push it\"${NC}"
        echo ""
      else
        # shellcheck disable=SC2015
        GH_OUTPUT=$(gh repo create "${GITHUB_USER}/${REPO_NAME}" --private --source=. --push 2>&1) && \
          echo -e "  ${GREEN}✓${NC} Pushed to github.com/${GITHUB_USER}/${REPO_NAME} (private)" || {
          echo -e "  ${YELLOW}GitHub repo creation didn't work:${NC}" >&2
          echo -e "  ${DIM}${GH_OUTPUT}${NC}"
          echo ""
          echo -e "  ${DIM}No worries — once you're in your first session, just tell your AI:${NC}"
          echo ""
          echo -e "  ${GREEN}\"Set up a private GitHub repo to back up my Contextium\"${NC}"
          echo ""
          echo -e "  ${DIM}It knows how to do this for you.${NC}"
        }
      fi
    fi
  fi

  # Install AI agent CLI
  echo ""
  echo -e "${BLUE}Setting up your AI agent...${NC}"
  HAS_NPM=false
  if command -v npm &>/dev/null; then
    HAS_NPM=true
  else
    # Auto-install Node.js if a CLI agent needs npm
    case "$AI_AGENT" in
      "Claude Code"*|"Gemini"*|"Codex"*)
        echo -e "  ${DIM}npm not found — installing Node.js...${NC}"
        if [[ "$OSTYPE" == "darwin"* ]]; then
          if command -v brew &>/dev/null; then
            brew install node 2>/dev/null && HAS_NPM=true
          fi
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
          curl -fsSL https://deb.nodesource.com/setup_lts.x 2>/dev/null | sudo -E bash - >/dev/null 2>&1
          sudo apt-get install -y nodejs >/dev/null 2>&1 && HAS_NPM=true
        fi
        if $HAS_NPM; then
          echo -e "  ${GREEN}✓${NC} Node.js installed"
        else
          echo -e "  ${YELLOW}Could not auto-install Node.js. Install manually: https://nodejs.org${NC}" >&2
        fi
        ;;
    esac
  fi
  # Use sudo for npm global installs on Linux
  NPM_GLOBAL="npm install -g"
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    NPM_GLOBAL="sudo npm install -g"
  fi
  AGENT_CMD=""
  case "$AI_AGENT" in
    "Claude Code"*)
      AGENT_CMD="claude"
      if ! command -v claude &>/dev/null; then
        if $HAS_NPM; then
          echo -e "  ${DIM}Installing Claude Code...${NC}"
          # shellcheck disable=SC2086
          $NPM_GLOBAL @anthropic-ai/claude-code 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Claude Code installed" || \
            echo -e "  ${YELLOW}Install failed. Try: sudo npm install -g @anthropic-ai/claude-code${NC}" >&2
        else
          echo -e "  ${YELLOW}npm not found. To install Claude Code:${NC}" >&2
          echo -e "  ${DIM}1. Install Node.js: https://nodejs.org${NC}"
          echo -e "  ${DIM}2. Then run: npm install -g @anthropic-ai/claude-code${NC}"
        fi
      else
        echo -e "  ${GREEN}✓${NC} Claude Code already installed"
      fi
      ;;
    "Gemini"*)
      AGENT_CMD="gemini"
      if ! command -v gemini &>/dev/null; then
        if $HAS_NPM; then
          echo -e "  ${DIM}Installing Gemini CLI...${NC}"
          # shellcheck disable=SC2086
          $NPM_GLOBAL @google/gemini-cli 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Gemini CLI installed" || \
            echo -e "  ${YELLOW}Install failed. Try: sudo npm install -g @google/gemini-cli${NC}" >&2
        else
          echo -e "  ${YELLOW}npm not found. To install Gemini CLI:${NC}" >&2
          echo -e "  ${DIM}1. Install Node.js: https://nodejs.org${NC}"
          echo -e "  ${DIM}2. Then run: npm install -g @google/gemini-cli${NC}"
        fi
      else
        echo -e "  ${GREEN}✓${NC} Gemini CLI already installed"
      fi
      ;;
    "Codex"*)
      AGENT_CMD="codex"
      if ! command -v codex &>/dev/null; then
        if $HAS_NPM; then
          echo -e "  ${DIM}Installing Codex CLI...${NC}"
          # shellcheck disable=SC2086
          $NPM_GLOBAL @openai/codex 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Codex installed" || \
            echo -e "  ${YELLOW}Install failed. Try: sudo npm install -g @openai/codex${NC}" >&2
        else
          echo -e "  ${YELLOW}npm not found. To install Codex CLI:${NC}" >&2
          echo -e "  ${DIM}1. Install Node.js: https://nodejs.org${NC}"
          echo -e "  ${DIM}2. Then run: npm install -g @openai/codex${NC}"
        fi
      else
        echo -e "  ${GREEN}✓${NC} Codex already installed"
      fi
      ;;
    "Cursor"*)
      AGENT_CMD="cursor ."
      if ! command -v cursor &>/dev/null; then
        echo -e "  ${YELLOW}Cursor is a desktop app — download from https://cursor.com${NC}"
      else
        echo -e "  ${GREEN}✓${NC} Cursor already installed"
      fi
      ;;
    "Windsurf"*)
      AGENT_CMD="windsurf ."
      if ! command -v windsurf &>/dev/null; then
        echo -e "  ${YELLOW}Windsurf is a desktop app — download from https://codeium.com/windsurf${NC}"
      else
        echo -e "  ${GREEN}✓${NC} Windsurf already installed"
      fi
      ;;
    "Cline"*)
      AGENT_CMD="code ."
      echo -e "  ${DIM}Cline is a VS Code extension — install it from the VS Code marketplace.${NC}"
      echo -e "  ${GREEN}✓${NC} Opening VS Code in your Contextium directory"
      ;;
    "Aider"*)
      AGENT_CMD="aider"
      if ! command -v aider &>/dev/null; then
        echo -e "  ${DIM}Installing Aider...${NC}"
        pip install aider-chat 2>/dev/null && \
          echo -e "  ${GREEN}✓${NC} Aider installed" || \
          echo -e "  ${YELLOW}Could not auto-install. Run: pip install aider-chat${NC}" >&2
      else
        echo -e "  ${GREEN}✓${NC} Aider already installed"
      fi
      ;;
    "Continue"*)
      AGENT_CMD="code ."
      echo -e "  ${DIM}Continue is a VS Code extension — install it from the VS Code marketplace.${NC}"
      echo -e "  ${GREEN}✓${NC} Opening VS Code in your Contextium directory"
      ;;
    "GitHub Copilot"*)
      AGENT_CMD="code ."
      echo -e "  ${DIM}GitHub Copilot is a VS Code extension — install it from the VS Code marketplace.${NC}"
      echo -e "  ${GREEN}✓${NC} Opening VS Code in your Contextium directory"
      ;;
    "Ollama"*)
      AGENT_CMD="ollama run contextium"
      if ! command -v ollama &>/dev/null; then
        echo -e "  ${DIM}Installing Ollama...${NC}"
        curl -fsSL https://ollama.com/install.sh | sh 2>/dev/null && \
          echo -e "  ${GREEN}✓${NC} Ollama installed" || \
          echo -e "  ${YELLOW}Install failed. Try: curl -fsSL https://ollama.com/install.sh | sh${NC}" >&2
      else
        echo -e "  ${GREEN}✓${NC} Ollama already installed"
      fi
      if command -v ollama &>/dev/null; then
        echo -e "  ${DIM}Pulling model: ${OLLAMA_MODEL} (this may take a few minutes)...${NC}"
        ollama pull "$OLLAMA_MODEL" 2>/dev/null && \
          echo -e "  ${GREEN}✓${NC} Model ${OLLAMA_MODEL} ready" || \
          echo -e "  ${YELLOW}Could not pull model. Run: ollama pull ${OLLAMA_MODEL}${NC}" >&2
        if [[ -f "Modelfile" ]]; then
          echo -e "  ${DIM}Creating contextium model from Modelfile...${NC}"
          ollama create contextium -f Modelfile 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Custom model 'contextium' created — run with: ollama run contextium" || \
            echo -e "  ${YELLOW}Could not create model. Run: ollama create contextium -f Modelfile${NC}" >&2
        fi
      fi
      ;;
    "Other"*)
      AGENT_CMD=""
      echo -e "  ${DIM}Your CLAUDE.md instruction file is ready — most AI agents will read it.${NC}"
      ;;
  esac

  # Done — launch agent
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Contextium is ready. Launching your AI...${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Launch the AI agent (or show instructions if piped/not installed)
  if [[ -z "$AGENT_CMD" ]]; then
    echo -e "  Run your AI agent from the ${BOLD}${DIR_NAME}${NC} directory."
    echo ""
  elif ! command -v "${AGENT_CMD%% *}" &>/dev/null; then
    echo -e "  Your AI agent isn't installed yet. Once installed, run:"
    echo ""
    echo -e "  ${BOLD}cd ${DIR_NAME}${NC}"
    echo -e "  ${BOLD}${AGENT_CMD}${NC}"
    echo ""
  elif [[ -t 0 ]]; then
    # stdin is a terminal — safe to launch
    # shellcheck disable=SC2086
    exec $AGENT_CMD
  else
    # stdin is a pipe (curl | bash) — can't launch interactively
    echo -e "  To start, run:"
    echo ""
    echo -e "  ${BOLD}cd ${DIR_NAME} && ${AGENT_CMD}${NC}"
    echo ""
  fi
}

# --- Update (existing install) ---

update() {
  banner

  # Verify we're in a Contextium repo (check for any known instruction file or the preferences dir)
  if [[ ! -d "preferences" ]] || [[ ! -d "knowledge" ]]; then
    echo -e "${YELLOW}This doesn't look like a Contextium repo.${NC}" >&2
    echo "Run this command from inside your Contextium directory." >&2
    exit 1
  fi

  # Check for upstream remote
  if ! git remote | grep -q upstream; then
    echo -e "${BLUE}Adding upstream remote...${NC}"
    git remote add upstream "$REPO"
  fi

  echo -e "${BLUE}Fetching updates...${NC}"
  git fetch upstream

  # Self-update: if upstream has a newer install.sh, replace ourselves and re-exec
  UPSTREAM_INSTALLER=$(git show upstream/main:install.sh 2>/dev/null) || true
  if [[ -n "$UPSTREAM_INSTALLER" ]]; then
    LOCAL_HASH=$(md5sum install.sh 2>/dev/null | cut -d' ' -f1)
    UPSTREAM_HASH=$(echo "$UPSTREAM_INSTALLER" | md5sum | cut -d' ' -f1)
    if [[ "$LOCAL_HASH" != "$UPSTREAM_HASH" ]] && [[ "${CONTEXTIUM_SELF_UPDATED:-}" != "1" ]]; then
      echo -e "  ${DIM}Updating installer...${NC}"
      echo "$UPSTREAM_INSTALLER" > install.sh
      chmod +x install.sh
      # shellcheck disable=SC2015
      git add install.sh && git commit -q -m "self-update: install.sh updated from upstream" 2>/dev/null || true
      echo -e "  ${GREEN}✓${NC} Installer updated — restarting"
      echo ""
      export CONTEXTIUM_SELF_UPDATED=1
      exec ./install.sh update
    fi
  fi

  # Show what changed
  LOCAL=$(git rev-parse HEAD)
  UPSTREAM=$(git rev-parse upstream/main 2>/dev/null || echo "")

  if [[ -z "$UPSTREAM" ]]; then
    echo -e "${YELLOW}Could not find upstream/main. Check your internet connection.${NC}" >&2
    exit 1
  fi

  if [[ "$LOCAL" = "$UPSTREAM" ]]; then
    echo -e "${GREEN}Already up to date.${NC}"
    exit 0
  fi

  echo ""
  echo -e "${BLUE}Changes available:${NC}"
  git log --oneline HEAD..upstream/main 2>/dev/null | head -20
  echo ""

  # Merge with protected paths (ours strategy via .gitattributes)
  echo -e "${BLUE}Merging updates (your data in preferences/, knowledge/, journal/, projects/ is protected)...${NC}"

  if git merge upstream/main --no-edit 2>/dev/null; then
    # Clean upstream-only files that shouldn't be in user repos
    rm -rf .github 2>/dev/null
    rm -f CHANGELOG.md CONTRIBUTING.md 2>/dev/null
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
      git add -A && git commit -q -m "cleanup: remove upstream-only files after update" 2>/dev/null
    fi
    # Re-copy agent instruction file from updated agent-configs/
    # The merge updates agent-configs/ but the root instruction file is a copy
    # that needs to be refreshed manually.
    if [[ -d "agent-configs" ]]; then
      if [[ -f ".cursorrules" ]] && [[ -f "agent-configs/cursor/.cursorrules" ]]; then
        cp "agent-configs/cursor/.cursorrules" ./.cursorrules
        echo -e "  ${GREEN}✓${NC} Updated .cursorrules"
      elif [[ -f ".windsurfrules" ]] && [[ -f "agent-configs/windsurf/.windsurfrules" ]]; then
        cp "agent-configs/windsurf/.windsurfrules" ./.windsurfrules
        echo -e "  ${GREEN}✓${NC} Updated .windsurfrules"
      elif [[ -f ".clinerules" ]] && [[ -f "agent-configs/cline/.clinerules" ]]; then
        cp "agent-configs/cline/.clinerules" ./.clinerules
        echo -e "  ${GREEN}✓${NC} Updated .clinerules"
      elif [[ -f "CONVENTIONS.md" ]] && [[ -f "agent-configs/aider/CONVENTIONS.md" ]]; then
        cp "agent-configs/aider/CONVENTIONS.md" ./CONVENTIONS.md
        echo -e "  ${GREEN}✓${NC} Updated CONVENTIONS.md"
      elif [[ -f ".continue/rules" ]] && [[ -f "agent-configs/continue/rules" ]]; then
        cp "agent-configs/continue/rules" ./.continue/rules
        echo -e "  ${GREEN}✓${NC} Updated .continue/rules"
      elif [[ -f ".github/copilot-instructions.md" ]] && [[ -f "agent-configs/copilot/copilot-instructions.md" ]]; then
        cp "agent-configs/copilot/copilot-instructions.md" ./.github/copilot-instructions.md
        echo -e "  ${GREEN}✓${NC} Updated copilot-instructions.md"
      elif [[ -f "GEMINI.md" ]] && [[ -f "agent-configs/gemini/GEMINI.md" ]]; then
        cp "agent-configs/gemini/GEMINI.md" ./GEMINI.md
        echo -e "  ${GREEN}✓${NC} Updated GEMINI.md"
      elif [[ -f "AGENTS.md" ]] && [[ -f "agent-configs/codex/AGENTS.md" ]]; then
        cp "agent-configs/codex/AGENTS.md" ./AGENTS.md
        echo -e "  ${GREEN}✓${NC} Updated AGENTS.md"
      elif [[ -f "Modelfile" ]] && [[ -f "agent-configs/ollama/Modelfile" ]]; then
        # Preserve user's model choice, update instructions
        CURRENT_MODEL=$(head -1 Modelfile | sed 's/^FROM //')
        sed "s/^FROM .*/FROM ${CURRENT_MODEL}/" "agent-configs/ollama/Modelfile" > ./Modelfile
        echo -e "  ${GREEN}✓${NC} Updated Modelfile (preserved model: ${CURRENT_MODEL})"
      fi
      # Default: CLAUDE.md (Claude Code, Other, or Ollama reference copy)
      if [[ -f "CLAUDE.md" ]] && [[ -f "agent-configs/claude/CLAUDE.md" ]]; then
        cp "agent-configs/claude/CLAUDE.md" ./CLAUDE.md
        echo -e "  ${GREEN}✓${NC} Updated CLAUDE.md"
      fi
      # Clean up agent-configs (configs already copied to root)
      rm -rf agent-configs 2>/dev/null
      # Commit instruction file refresh + cleanup
      if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
        git add -A && git commit -q -m "update: refresh instruction file, remove agent-configs" 2>/dev/null
      fi
    fi

    echo ""
    echo -e "${GREEN}Update complete!${NC}"
    echo ""
    echo "Updated files:"
    git diff --name-only HEAD~3..HEAD 2>/dev/null | head -20
  else
    echo ""
    echo -e "${YELLOW}Merge conflicts detected. Resolve them manually:${NC}" >&2
    git diff --name-only --diff-filter=U
    echo ""
    echo "After resolving: git add <files> && git commit"
  fi
}

# --- Test (non-interactive, uses defaults) ---

test_install() {
  banner
  echo -e "${BLUE}Running test install with defaults...${NC}"
  echo ""

  ensure_prerequisites

  # Use test defaults instead of interactive prompts
  USER_NAME="Test User"
  DIR_NAME="contextium-test"
  AI_AGENT="Claude Code (recommended)"
  OLLAMA_MODEL="llama3.1"
  COMM_STYLE="Concise — get to the point, no filler"
  PROFESSION="Software engineer"
  AI_GOAL="Ship code faster"
  AUTONOMY="Balanced — act on routine tasks, ask on big decisions"
  WORK_STYLE="Solo — just me"
  CREATE_REPO="no"

  if [[ -d "$DIR_NAME" ]]; then
    rm -rf "$DIR_NAME"
  fi

  echo -e "${BLUE}Setting up your Contextium...${NC}"
  echo ""

  # Clone template
  git clone "$REPO" "$DIR_NAME" 2>/dev/null
  cd "$DIR_NAME"

  # Rename origin to upstream
  git remote rename origin upstream

  # Copy agent config (test always uses Claude Code)
  cp "agent-configs/claude/CLAUDE.md" ./CLAUDE.md
  echo -e "  ${GREEN}✓${NC} Installed → CLAUDE.md"

  # Clean up upstream files
  rm -rf agent-configs
  rm -rf .github
  rm -f CHANGELOG.md CONTRIBUTING.md
  echo -e "  ${GREEN}✓${NC} Cleaned up upstream files"

  # Create profile and preferences
  create_profile "$USER_NAME" "test-user" "$PROFESSION" "$AI_GOAL"

  COMM_SHORT="concise"
  AUTONOMY_SHORT="balanced"
  WORK_STYLE_SHORT="solo"
  write_preferences "$USER_NAME" "$COMM_SHORT" "$PROFESSION" "$AI_GOAL" "$AUTONOMY_SHORT" "$WORK_STYLE_SHORT"
  apply_autonomy_mode "$AUTONOMY_SHORT"

  # Set git identity if not configured
  if ! git config user.name &>/dev/null; then
    git config user.name "${USER_NAME}"
  fi
  if ! git config user.email &>/dev/null; then
    git config user.email "contextium@localhost"
  fi

  # Git commit
  git add -A
  git commit -q -m "Initial Contextium setup for ${USER_NAME} (${VERSION})"

  # Verify
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Test install complete!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Run verification checks
  echo -e "${BLUE}Verification:${NC}"
  [[ -f CLAUDE.md ]] && echo -e "  ${GREEN}✓${NC} CLAUDE.md exists" || echo -e "  ${YELLOW}✗${NC} CLAUDE.md missing"
  [[ -f preferences/user/preferences.md ]] && echo -e "  ${GREEN}✓${NC} Preferences file exists" || echo -e "  ${YELLOW}✗${NC} Preferences missing"
  [[ -d "knowledge/people/test-user" ]] && echo -e "  ${GREEN}✓${NC} User profile exists" || echo -e "  ${YELLOW}✗${NC} User profile missing"
  [[ -f preferences/rules/behavior.md ]] && echo -e "  ${GREEN}✓${NC} Behavior file exists" || echo -e "  ${YELLOW}✗${NC} Behavior file missing"
  [[ ! -d "agent-configs" ]] && echo -e "  ${GREEN}✓${NC} agent-configs removed" || echo -e "  ${YELLOW}✗${NC} agent-configs still present"
  echo ""

  FILE_COUNT=$(find . -type f -not -path './.git/*' | wc -l)
  DIR_COUNT=$(find . -type d -not -path './.git/*' -not -path './.git' | wc -l)
  echo -e "  Files: ${FILE_COUNT} | Directories: ${DIR_COUNT}"
  echo ""
  echo -e "  ${DIM}Test directory: $(pwd)${NC}"
  echo -e "  ${DIM}Clean up with: rm -rf $(pwd)${NC}"
}

# --- Route ---

case "${1:-init}" in
  init)
    init
    ;;
  update)
    update
    ;;
  test)
    test_install
    ;;
  *)
    echo "Usage: $0 [init|update|test]"
    echo "  init   — Set up a new Contextium repo (default)"
    echo "  update — Pull latest framework updates"
    echo "  test   — Non-interactive test install with defaults"
    exit 1
    ;;
esac
