#!/usr/bin/env bash
set -euo pipefail

# Contextium Installer
# Usage:
#   Fresh install: curl -sSL contextium.ai/install | bash
#   Update:        ./install.sh update

REPO="https://github.com/Ashkaan/contextium.git"
VERSION="v1.2.1"

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
      echo -e "${YELLOW}Please install Homebrew first: https://brew.sh${NC}"
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
      echo -e "${YELLOW}Could not auto-install gum. Install manually: https://github.com/charmbracelet/gum${NC}"
      exit 1
    fi
  else
    echo -e "${YELLOW}Unsupported OS. Install gum manually: https://github.com/charmbracelet/gum${NC}"
    exit 1
  fi

  if ! command -v gum &>/dev/null; then
    echo -e "${YELLOW}Failed to install gum. Install manually: https://github.com/charmbracelet/gum${NC}"
    exit 1
  fi
  echo -e "${GREEN}gum installed.${NC}"
}

ensure_prerequisites() {
  local missing=0

  if ! command -v git &>/dev/null; then
    echo -e "${YELLOW}git is required but not installed.${NC}"
    echo -e "  macOS: ${BOLD}xcode-select --install${NC}"
    echo -e "  Linux: ${BOLD}sudo apt install git${NC} or ${BOLD}sudo yum install git${NC}"
    missing=1
  fi

  if ! command -v npm &>/dev/null; then
    echo -e "${DIM}npm not found — some AI agents (Claude Code, Codex, Gemini) need it for install.${NC}"
    echo -e "${DIM}You can install Node.js from https://nodejs.org if needed.${NC}"
  fi

  if [ $missing -eq 1 ]; then
    echo ""
    echo -e "${YELLOW}Install the missing prerequisites and run again.${NC}"
    exit 1
  fi
}

# --- Init (fresh install) ---

init() {
  banner
  ensure_gum
  ensure_prerequisites

  # Step 1: Name
  echo -e "${BOLD}What's your name?${NC}"
  echo -e "${DIM}So your AI recognizes you across sessions and never has to ask again.${NC}"
  USER_NAME=$(gum input --placeholder "Your name" --width 40)
  if [ -z "$USER_NAME" ]; then
    echo -e "${YELLOW}Name is required.${NC}"
    exit 1
  fi
  echo ""

  # Step 2: Directory
  echo -e "${BOLD}Where should we set up your Contextium?${NC}"
  echo -e "${DIM}Everything lives in one folder — your AI reads and writes here across sessions.${NC}"
  DIR_NAME=$(gum input --placeholder "my-context" --value "my-context" --width 40)
  DIR_NAME="${DIR_NAME:-my-context}"
  if [ -d "$DIR_NAME" ]; then
    echo -e "${YELLOW}Directory '$DIR_NAME' already exists. Use './install.sh update' inside it to update.${NC}"
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
    "Other")
  echo -e "${DIM}Selected: ${AI_AGENT}${NC}"
  echo ""

  # Step 4: Integrations (sectioned by category)
  INTEGRATIONS=""

  # 4a: AI delegation
  AI_ITEMS=()
  AI_PRESELECTED=()
  if [[ "$AI_AGENT" != "Claude"* ]]; then
    AI_ITEMS+=("Claude Code (delegate strategy and complex reasoning)")
    AI_PRESELECTED+=("--selected=Claude Code (delegate strategy and complex reasoning)")
  fi
  if [[ "$AI_AGENT" != "Codex"* ]]; then
    AI_ITEMS+=("Codex (delegate bulk edits to a second AI agent)")
    AI_PRESELECTED+=("--selected=Codex (delegate bulk edits to a second AI agent)")
  fi
  if [[ "$AI_AGENT" != "Gemini"* ]]; then
    AI_ITEMS+=("Gemini (delegate web research to Google's AI)")
    AI_PRESELECTED+=("--selected=Gemini (delegate web research to Google's AI)")
  fi
  AI_ITEMS+=("Browse (browser automation for web scraping and testing)")

  if [ ${#AI_ITEMS[@]} -gt 0 ]; then
    echo -e "${BOLD}Want to delegate tasks to other AI agents?${NC}"
    echo -e "${DIM}Your primary AI can route work to cheaper/specialized agents —${NC}"
    echo -e "${DIM}research to Gemini, bulk edits to Codex. Saves tokens and money.${NC}"
    echo -e "${DIM}(Space to toggle, Enter to confirm)${NC}"
    echo ""
    AI_SELECTED=$(gum choose --no-limit --cursor-prefix "[ ] " --selected-prefix "[x] " \
      "${AI_PRESELECTED[@]}" \
      "${AI_ITEMS[@]}" \
      || echo "")
    INTEGRATIONS="${INTEGRATIONS}${AI_SELECTED}"$'\n'
    echo ""
  fi

  # 4b: Productivity
  echo -e "${BOLD}Which productivity tools do you use?${NC}"
  echo -e "${DIM}Your AI can read your calendar, manage tasks, and access files —${NC}"
  echo -e "${DIM}so it has context about your schedule and priorities.${NC}"
  echo -e "${DIM}(Space to toggle, Enter to confirm)${NC}"
  echo ""
  PROD_SELECTED=$(gum choose --no-limit --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "1Password (store API keys and credentials securely)" \
    "Google Workspace (Gmail, Calendar, Drive, Sheets)" \
    "Todoist (task management and to-do tracking)" \
    || echo "")
  INTEGRATIONS="${INTEGRATIONS}${PROD_SELECTED}"$'\n'
  echo ""

  # 4c: Automation
  echo -e "${BOLD}Do you want to automate recurring tasks?${NC}"
  echo -e "${DIM}Automation platforms let your AI schedule workflows —${NC}"
  echo -e "${DIM}morning briefings, data syncs, alerts — that run without you.${NC}"
  echo -e "${DIM}(Space to toggle, Enter to confirm)${NC}"
  echo ""
  AUTO_SELECTED=$(gum choose --no-limit --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "Windmill (self-hosted workflow automation — like Zapier but yours)" \
    "n8n (self-hosted workflow automation — alternative to Windmill)" \
    || echo "")
  INTEGRATIONS="${INTEGRATIONS}${AUTO_SELECTED}"$'\n'
  echo ""

  # 4d: Infrastructure
  echo -e "${BOLD}Do you self-host or manage infrastructure?${NC}"
  echo -e "${DIM}If you run servers, a NAS, or manage DNS — your AI can${NC}"
  echo -e "${DIM}monitor, deploy, and troubleshoot alongside you.${NC}"
  echo -e "${DIM}(Space to toggle, Enter to confirm)${NC}"
  echo ""
  INFRA_SELECTED=$(gum choose --no-limit --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "Cloudflare (DNS, web hosting, serverless functions)" \
    "TrueNAS (NAS and Docker container management via SSH)" \
    "Garage (S3-compatible object storage for backups)" \
    "Home Assistant (smart home control and automation)" \
    || echo "")
  INTEGRATIONS="${INTEGRATIONS}${INFRA_SELECTED}"$'\n'
  echo ""

  # 4e: Business tools
  echo -e "${BOLD}Do you use any business or finance tools?${NC}"
  echo -e "${DIM}Your AI can pull reports, track KPIs, and manage tickets —${NC}"
  echo -e "${DIM}skip these if you don't run a business.${NC}"
  echo -e "${DIM}(Space to toggle, Enter to confirm)${NC}"
  echo ""
  BIZ_SELECTED=$(gum choose --no-limit --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "QuickBooks Online (business accounting and financial reports)" \
    "Monarch (personal finance tracking and budgeting)" \
    "Autotask (PSA/ticketing for managed service providers)" \
    "NinjaOne (device inventory and remote monitoring)" \
    "Strety (EOS platform — scorecards, rocks, meeting management)" \
    "Hudu (IT documentation platform)" \
    "MSPBots (MSP-specific analytics and KPI dashboards)" \
    || echo "")
  INTEGRATIONS="${INTEGRATIONS}${BIZ_SELECTED}"$'\n'
  echo ""

  # 4f: Interfaces
  echo -e "${BOLD}Want additional ways to access your AI?${NC}"
  echo -e "${DIM}Beyond your terminal — e-ink dashboards, voice control,${NC}"
  echo -e "${DIM}mobile access, or remote development.${NC}"
  echo -e "${DIM}(Space to toggle, Enter to confirm)${NC}"
  echo ""
  IFACE_SELECTED=$(gum choose --no-limit --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "TRMNL (e-ink display dashboard for at-a-glance info)" \
    "Remote Control (access your AI from your phone)" \
    "HAPI (voice interface — talk to your AI)" \
    "VS Code (remote development tunnel)" \
    || echo "")
  INTEGRATIONS="${INTEGRATIONS}${IFACE_SELECTED}"
  echo ""

  # Step 5: Communication style
  echo -e "${BOLD}How should your AI communicate with you?${NC}"
  echo -e "${DIM}This shapes every interaction — your AI will match your style from day one.${NC}"
  COMM_STYLE=$(gum choose \
    "Concise — get to the point, no filler" \
    "Balanced — brief but include reasoning" \
    "Thorough — explain your thinking, show alternatives")
  echo ""

  # Step 6: Professional context
  echo -e "${BOLD}What do you do? (one line is fine)${NC}"
  echo -e "${DIM}So your AI understands your professional context and can give relevant advice.${NC}"
  PROFESSION=$(gum input --placeholder "e.g. Software engineer at a startup, MSP owner, freelance designer...")
  echo ""

  # Step 7: Primary AI goal
  echo -e "${BOLD}What's the #1 thing you want AI to help with?${NC}"
  echo -e "${DIM}This becomes your AI's north star — it'll prioritize suggestions around this.${NC}"
  AI_GOAL=$(gum input --placeholder "e.g. Ship code faster, manage my business, organize my life...")
  echo ""

  # Step 8: First knowledge domain
  echo -e "${BOLD}Pick a knowledge domain to start with.${NC}"
  echo -e "${DIM}This is just your first one — more will naturally appear as you work.${NC}"
  echo -e "${DIM}Your AI creates knowledge directories on demand, so don't overthink this.${NC}"
  FIRST_DOMAIN=$(gum choose \
    "work — professional projects, clients, strategy" \
    "health — biomarkers, supplements, fitness" \
    "finance — budgets, investments, tax planning" \
    "growth — goals, learning, personal development" \
    "home — property, vehicles, maintenance" \
    "Other (I'll type it)")
  if [[ "$FIRST_DOMAIN" == "Other"* ]]; then
    FIRST_DOMAIN=$(gum input --placeholder "e.g. recipes, gaming, music, legal...")
  else
    FIRST_DOMAIN="${FIRST_DOMAIN%% —*}"
  fi
  echo ""

  # Step 9: Private GitHub repo
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
        brew install gh 2>/dev/null || { echo -e "${YELLOW}Could not install gh. Install manually: https://cli.github.com${NC}"; CREATE_REPO="no"; }
      elif command -v apt-get &>/dev/null; then
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
        sudo apt-get update -qq -o Dir::Etc::sourcelist="sources.list.d/github-cli.list" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" && sudo apt-get install -y -qq gh >/dev/null 2>&1
        echo -e "  ${GREEN}✓${NC} GitHub CLI installed"
      else
        echo -e "${YELLOW}Could not install gh. Install manually: https://cli.github.com${NC}"
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
          echo -e "${YELLOW}GitHub auth didn't complete. No worries — you can do this later:${NC}"
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
    echo -e "${YELLOW}Failed to clone the Contextium template. Check your internet connection.${NC}"
    exit 1
  fi
  cd "$DIR_NAME" || { echo -e "${YELLOW}Failed to enter directory '$DIR_NAME'.${NC}"; exit 1; }

  # Rename origin to upstream (framework source for future updates)
  git remote rename origin upstream

  # Copy agent config to the correct filename for the selected agent
  # The content is the same core instruction set — context router, rules, structure —
  # but each agent reads from a different filename.
  INSTRUCTION_SRC="agent-configs/claude/CLAUDE.md"

  case "$AI_AGENT" in
    "Claude Code"*)
      cp "$INSTRUCTION_SRC" ./CLAUDE.md
      echo -e "  ${GREEN}✓${NC} Installed → CLAUDE.md"
      ;;
    "Gemini"*)
      cp "$INSTRUCTION_SRC" ./GEMINI.md
      echo -e "  ${GREEN}✓${NC} Installed → GEMINI.md"
      ;;
    "Codex"*)
      cp "$INSTRUCTION_SRC" ./AGENTS.md
      echo -e "  ${GREEN}✓${NC} Installed → AGENTS.md"
      ;;
    "Cursor"*)
      cp "$INSTRUCTION_SRC" ./.cursorrules
      echo -e "  ${GREEN}✓${NC} Installed → .cursorrules"
      ;;
    "Windsurf"*)
      cp "$INSTRUCTION_SRC" ./.windsurfrules
      echo -e "  ${GREEN}✓${NC} Installed → .windsurfrules"
      ;;
    "Cline"*)
      cp "$INSTRUCTION_SRC" ./.clinerules
      echo -e "  ${GREEN}✓${NC} Installed → .clinerules"
      ;;
    "Aider"*)
      cp "$INSTRUCTION_SRC" ./CONVENTIONS.md
      echo -e "  ${GREEN}✓${NC} Installed → CONVENTIONS.md"
      ;;
    "Continue"*)
      mkdir -p .continue
      cp "$INSTRUCTION_SRC" ./.continue/rules
      echo -e "  ${GREEN}✓${NC} Installed → .continue/rules"
      ;;
    "GitHub Copilot"*)
      mkdir -p .github
      cp "$INSTRUCTION_SRC" ./.github/copilot-instructions.md
      echo -e "  ${GREEN}✓${NC} Installed → .github/copilot-instructions.md"
      ;;
    "Other"*)
      cp "$INSTRUCTION_SRC" ./CLAUDE.md
      echo -e "  ${GREEN}✓${NC} Installed → CLAUDE.md (universal default)"
      echo -e "  ${DIM}Rename to match your agent's instruction file format if needed.${NC}"
      ;;
  esac

  # Clean up agent-configs (the right file is already at root)
  rm -rf agent-configs
  echo -e "  ${GREEN}✓${NC} Cleaned up agent templates"

  # Also remove the starter CLAUDE.md if a different agent was selected
  if [[ "$AI_AGENT" != "Claude Code"* && "$AI_AGENT" != "Other"* ]]; then
    rm -f CLAUDE.md
  fi

  # Map integration display names to directory names
  declare -A INTEGRATION_MAP=(
    ["1Password (store API keys and credentials securely)"]="1password"
    ["Google Workspace (Gmail, Calendar, Drive, Sheets)"]="google-workspace google-auth"
    ["Todoist (task management and to-do tracking)"]="todoist"
    ["Gemini (delegate web research to Google's AI)"]="gemini"
    ["Codex (delegate bulk edits to a second AI agent)"]="codex"
    ["Browse (browser automation for web scraping and testing)"]="browse"
    ["Windmill (self-hosted workflow automation — like Zapier but yours)"]="windmill"
    ["n8n (self-hosted workflow automation — alternative to Windmill)"]="n8n"
    ["Cloudflare (DNS, web hosting, serverless functions)"]="cloudflare"
    ["TrueNAS (NAS and Docker container management via SSH)"]="truenas"
    ["Home Assistant (smart home control and automation)"]="home-assistant"
    ["Autotask (PSA/ticketing for managed service providers)"]="autotask"
    ["NinjaOne (device inventory and remote monitoring)"]="ninjaone"
    ["QuickBooks Online (business accounting and financial reports)"]="qbo"
    ["Monarch (personal finance tracking and budgeting)"]="monarch"
    ["Strety (EOS platform — scorecards, rocks, meeting management)"]="strety"
    ["Hudu (IT documentation platform)"]="hudu"
    ["MSPBots (MSP-specific analytics and KPI dashboards)"]="mspbots"
    ["Garage (S3-compatible object storage for backups)"]="garage"
    ["TRMNL (e-ink display dashboard for at-a-glance info)"]="trmnl"
    ["Remote Control (access your AI from your phone)"]="remote-control"
    ["HAPI (voice interface — talk to your AI)"]="hapi"
    ["VS Code (remote development tunnel)"]="vscode"
  )

  # Build list of selected integration directories
  SELECTED_DIRS=""
  while IFS= read -r line; do
    if [ -n "$line" ] && [ -n "${INTEGRATION_MAP[$line]+x}" ]; then
      for dir in ${INTEGRATION_MAP[$line]}; do
        SELECTED_DIRS="$SELECTED_DIRS $dir"
      done
    fi
  done <<< "$INTEGRATIONS"

  # Always keep: README.md, daedalus, host-docs-map (infrastructure)
  SELECTED_DIRS="$SELECTED_DIRS daedalus host-docs-map"

  # Remove unselected integrations
  REMOVED=0
  for dir in integrations/*/; do
    dirname=$(basename "$dir")
    if [ "$dirname" = "README.md" ]; then continue; fi
    if ! echo "$SELECTED_DIRS" | grep -qw "$dirname"; then
      rm -rf "$dir"
      REMOVED=$((REMOVED + 1))
    fi
  done
  KEPT=$(find integrations -mindepth 1 -maxdepth 1 -type d | wc -l)
  echo -e "  ${GREEN}✓${NC} ${KEPT} integrations installed (${REMOVED} skipped)"

  # Create user profile
  USER_NAME_LOWER=$(echo "$USER_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  mkdir -p "knowledge/people/${USER_NAME_LOWER}"
  cat > "knowledge/people/${USER_NAME_LOWER}/README.md" << PROFILE_EOF
# ${USER_NAME}

**Added:** $(date +%Y-%m-%d)

## About

${PROFESSION}

## AI Goal

${AI_GOAL}
PROFILE_EOF
  echo -e "  ${GREEN}✓${NC} Profile created for ${USER_NAME}"

  # Write full preferences file
  COMM_SHORT=""
  case "$COMM_STYLE" in
    "Concise"*)  COMM_SHORT="concise" ;;
    "Balanced"*) COMM_SHORT="balanced" ;;
    "Thorough"*) COMM_SHORT="thorough" ;;
  esac
  cat > preferences/user/preferences.md << PREFS_EOF
# User Preferences — ${USER_NAME}

## Communication

$(case "$COMM_SHORT" in
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

${PROFESSION}

## Primary Goal with AI

${AI_GOAL}

## Working Style

*Update this as your AI learns how you work best.*
PREFS_EOF
  echo -e "  ${GREEN}✓${NC} Preferences configured (${COMM_SHORT} communication)"

  # Create first knowledge domain
  DOMAIN_LOWER=$(echo "$FIRST_DOMAIN" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  mkdir -p "knowledge/${DOMAIN_LOWER}"
  cat > "knowledge/${DOMAIN_LOWER}/README.md" << DOMAIN_EOF
# ${FIRST_DOMAIN^}

Persistent context for ${FIRST_DOMAIN}. Add files here as knowledge accumulates.

**Created:** $(date +%Y-%m-%d)
DOMAIN_EOF
  echo -e "  ${GREEN}✓${NC} Knowledge domain created: ${FIRST_DOMAIN}"

  # Update integrations/README.md to only show installed integrations
  if [ -f integrations/README.md ]; then
    # Build list of installed integration directories
    INSTALLED_DIRS=$(find integrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)

    # Create a temp file with only the rows for installed integrations
    # Keep header lines and rows whose link target matches an installed directory
    python3 -c "
import os, re, sys
lines = open('integrations/README.md').readlines()
installed = set(os.listdir('integrations')) - {'README.md'}
installed = {d for d in installed if os.path.isdir(f'integrations/{d}')}
out = []
in_table = False
for line in lines:
    # Detect table rows with integration links like [name](dirname/)
    m = re.match(r'\| \[.*?\]\((\w[\w-]*)/?\)', line)
    if m:
        in_table = True
        dirname = m.group(1)
        if dirname in installed:
            out.append(line)
    else:
        out.append(line)
open('integrations/README.md', 'w').writelines(out)
" 2>/dev/null || true
  fi
  echo -e "  ${GREEN}✓${NC} Integration docs updated to match your selection"

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
    if [ -n "$GITHUB_USER" ]; then
      DEFAULT_REPO=$(basename "$(pwd)")
      echo -e "${BOLD}What should the GitHub repo be called?${NC}"
      echo -e "${DIM}This will be private at github.com/${GITHUB_USER}/...${NC}"
      REPO_NAME=$(gum input --placeholder "$DEFAULT_REPO" --value "$DEFAULT_REPO" --width 40)
      REPO_NAME="${REPO_NAME:-$DEFAULT_REPO}"
      echo ""
      echo -e "${BLUE}Creating private GitHub repo...${NC}"
      # Detect Codespace token limitations
      if [ -n "${CODESPACES:-}" ]; then
        echo -e "  ${YELLOW}GitHub Codespaces uses a restricted token that can't create repos.${NC}"
        echo -e "  ${DIM}No worries — once you install Contextium on your real machine,${NC}"
        echo -e "  ${DIM}open your AI and say:${NC}"
        echo ""
        echo -e "  ${GREEN}\"Create a private GitHub repo for my Contextium and push it\"${NC}"
        echo ""
      else
        GH_OUTPUT=$(gh repo create "${GITHUB_USER}/${REPO_NAME}" --private --source=. --push 2>&1) && \
          echo -e "  ${GREEN}✓${NC} Pushed to github.com/${GITHUB_USER}/${REPO_NAME} (private)" || {
          echo -e "  ${YELLOW}GitHub repo creation didn't work:${NC}"
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
  fi
  AGENT_CMD=""
  case "$AI_AGENT" in
    "Claude Code"*)
      AGENT_CMD="claude"
      if ! command -v claude &>/dev/null; then
        if $HAS_NPM; then
          echo -e "  ${DIM}Installing Claude Code...${NC}"
          npm install -g @anthropic-ai/claude-code 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Claude Code installed" || \
            echo -e "  ${YELLOW}Install failed. Try: npm install -g @anthropic-ai/claude-code${NC}"
        else
          echo -e "  ${YELLOW}npm not found. To install Claude Code:${NC}"
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
          npm install -g @google/gemini-cli 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Gemini CLI installed" || \
            echo -e "  ${YELLOW}Install failed. Try: npm install -g @google/gemini-cli${NC}"
        else
          echo -e "  ${YELLOW}npm not found. To install Gemini CLI:${NC}"
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
          npm install -g @openai/codex 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Codex installed" || \
            echo -e "  ${YELLOW}Install failed. Try: npm install -g @openai/codex${NC}"
        else
          echo -e "  ${YELLOW}npm not found. To install Codex CLI:${NC}"
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
          echo -e "  ${YELLOW}Could not auto-install. Run: pip install aider-chat${NC}"
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

  # Launch the AI agent in the new directory
  if command -v ${AGENT_CMD%% *} &>/dev/null; then
    exec $AGENT_CMD
  else
    echo -e "  Your AI agent isn't installed yet. Once installed, run:"
    echo ""
    echo -e "  ${BOLD}cd ${DIR_NAME}${NC}"
    echo -e "  ${BOLD}${AGENT_CMD}${NC}"
    echo -e "  ${DIM}It will walk you through the rest of the setup.${NC}"
    echo ""
  fi
}

# --- Update (existing install) ---

update() {
  banner

  # Verify we're in a Contextium repo (check for any known instruction file or the preferences dir)
  if [ ! -d "preferences" ] || [ ! -d "knowledge" ]; then
    echo -e "${YELLOW}This doesn't look like a Contextium repo.${NC}"
    echo "Run this command from inside your Contextium directory."
    exit 1
  fi

  # Check for upstream remote
  if ! git remote | grep -q upstream; then
    echo -e "${BLUE}Adding upstream remote...${NC}"
    git remote add upstream "$REPO"
  fi

  echo -e "${BLUE}Fetching updates...${NC}"
  git fetch upstream

  # Show what changed
  LOCAL=$(git rev-parse HEAD)
  UPSTREAM=$(git rev-parse upstream/main 2>/dev/null || echo "")

  if [ -z "$UPSTREAM" ]; then
    echo -e "${YELLOW}Could not find upstream/main. Check your internet connection.${NC}"
    exit 1
  fi

  if [ "$LOCAL" = "$UPSTREAM" ]; then
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
    echo ""
    echo -e "${GREEN}Update complete!${NC}"
    echo ""
    echo "Updated files:"
    git diff --name-only HEAD~1..HEAD 2>/dev/null | head -20
  else
    echo ""
    echo -e "${YELLOW}Merge conflicts detected. Resolve them manually:${NC}"
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
  INTEGRATIONS="Gemini (delegate web research to Google's AI)"
  COMM_STYLE="Concise — get to the point, no filler"
  PROFESSION="Software engineer"
  AI_GOAL="Ship code faster"
  FIRST_DOMAIN="work"
  CREATE_REPO="no"

  if [ -d "$DIR_NAME" ]; then
    rm -rf "$DIR_NAME"
  fi

  echo -e "${BLUE}Setting up your Contextium...${NC}"
  echo ""

  # Clone template
  git clone "$REPO" "$DIR_NAME" 2>/dev/null
  cd "$DIR_NAME"

  # Rename origin to upstream
  git remote rename origin upstream

  # Copy agent config
  INSTRUCTION_SRC="agent-configs/claude/CLAUDE.md"
  cp "$INSTRUCTION_SRC" ./CLAUDE.md
  echo -e "  ${GREEN}✓${NC} Installed → CLAUDE.md"

  # Remove unselected integrations
  declare -A INTEGRATION_MAP=(
    ["Gemini (delegate web research to Google's AI)"]="gemini"
    ["Codex (delegate bulk edits to a second AI agent)"]="codex"
    ["Browse (browser automation for web scraping and testing)"]="browse"
    ["1Password (store API keys and credentials securely)"]="1password"
    ["Google Workspace (Gmail, Calendar, Drive, Sheets)"]="google-workspace google-auth"
    ["Todoist (task management and to-do tracking)"]="todoist"
    ["Windmill (self-hosted workflow automation — like Zapier but yours)"]="windmill"
    ["n8n (self-hosted workflow automation — alternative to Windmill)"]="n8n"
    ["Cloudflare (DNS, web hosting, serverless functions)"]="cloudflare"
    ["TrueNAS (NAS and Docker container management via SSH)"]="truenas"
    ["Home Assistant (smart home control and automation)"]="home-assistant"
    ["Autotask (PSA/ticketing for managed service providers)"]="autotask"
    ["NinjaOne (device inventory and remote monitoring)"]="ninjaone"
    ["QuickBooks Online (business accounting and financial reports)"]="qbo"
    ["Monarch (personal finance tracking and budgeting)"]="monarch"
    ["Strety (EOS platform — scorecards, rocks, meeting management)"]="strety"
    ["Hudu (IT documentation platform)"]="hudu"
    ["MSPBots (MSP-specific analytics and KPI dashboards)"]="mspbots"
    ["Garage (S3-compatible object storage for backups)"]="garage"
    ["TRMNL (e-ink display dashboard for at-a-glance info)"]="trmnl"
    ["Remote Control (access your AI from your phone)"]="remote-control"
    ["HAPI (voice interface — talk to your AI)"]="hapi"
    ["VS Code (remote development tunnel)"]="vscode"
  )

  SELECTED_DIRS=""
  while IFS= read -r line; do
    if [ -n "$line" ] && [ -n "${INTEGRATION_MAP[$line]+x}" ]; then
      for dir in ${INTEGRATION_MAP[$line]}; do
        SELECTED_DIRS="$SELECTED_DIRS $dir"
      done
    fi
  done <<< "$INTEGRATIONS"
  SELECTED_DIRS="$SELECTED_DIRS daedalus host-docs-map"

  REMOVED=0
  for dir in integrations/*/; do
    dirname=$(basename "$dir")
    if ! echo "$SELECTED_DIRS" | grep -qw "$dirname"; then
      rm -rf "$dir"
      REMOVED=$((REMOVED + 1))
    fi
  done
  KEPT=$(find integrations -mindepth 1 -maxdepth 1 -type d | wc -l)
  echo -e "  ${GREEN}✓${NC} ${KEPT} integrations installed (${REMOVED} skipped)"

  # Create user profile
  USER_NAME_LOWER="test-user"
  mkdir -p "knowledge/people/${USER_NAME_LOWER}"
  cat > "knowledge/people/${USER_NAME_LOWER}/README.md" << PROFILE_EOF
# ${USER_NAME}

**Added:** $(date +%Y-%m-%d)

## About

${PROFESSION}

## AI Goal

${AI_GOAL}
PROFILE_EOF
  echo -e "  ${GREEN}✓${NC} Profile created for ${USER_NAME}"

  # Write preferences
  cat > preferences/user/preferences.md << PREFS_EOF
# User Preferences — ${USER_NAME}

## Communication

- **Concise over verbose** — get to the point
- **Direct over diplomatic** — say what you mean
- **Practical over theoretical** — focus on what works

## Professional Context

${PROFESSION}

## Primary Goal with AI

${AI_GOAL}

## Working Style

*Update this as your AI learns how you work best.*
PREFS_EOF
  echo -e "  ${GREEN}✓${NC} Preferences configured (concise communication)"

  # Create first knowledge domain
  mkdir -p "knowledge/${FIRST_DOMAIN}"
  cat > "knowledge/${FIRST_DOMAIN}/README.md" << DOMAIN_EOF
# Work

Persistent context for work. Add files here as knowledge accumulates.

**Created:** $(date +%Y-%m-%d)
DOMAIN_EOF
  echo -e "  ${GREEN}✓${NC} Knowledge domain created: ${FIRST_DOMAIN}"

  # Update integrations README
  if [ -f integrations/README.md ] && command -v python3 &>/dev/null; then
    python3 -c "
import os, re
lines = open('integrations/README.md').readlines()
installed = set(os.listdir('integrations')) - {'README.md'}
installed = {d for d in installed if os.path.isdir(f'integrations/{d}')}
out = []
for line in lines:
    m = re.match(r'\| \[.*?\]\((\w[\w-]*)/?\)', line)
    if m:
        dirname = m.group(1)
        if dirname in installed:
            out.append(line)
    else:
        out.append(line)
open('integrations/README.md', 'w').writelines(out)
" 2>/dev/null || true
  fi
  echo -e "  ${GREEN}✓${NC} Integration docs updated"

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
  git remote add upstream "$REPO"

  # Verify
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Test install complete!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  # Run verification checks
  echo -e "${BLUE}Verification:${NC}"
  [ -f CLAUDE.md ] && echo -e "  ${GREEN}✓${NC} CLAUDE.md exists" || echo -e "  ${YELLOW}✗${NC} CLAUDE.md missing"
  [ -f preferences/user/preferences.md ] && echo -e "  ${GREEN}✓${NC} Preferences file exists" || echo -e "  ${YELLOW}✗${NC} Preferences missing"
  [ -d "knowledge/people/test-user" ] && echo -e "  ${GREEN}✓${NC} User profile exists" || echo -e "  ${YELLOW}✗${NC} User profile missing"
  [ -d "knowledge/work" ] && echo -e "  ${GREEN}✓${NC} Knowledge domain exists" || echo -e "  ${YELLOW}✗${NC} Knowledge domain missing"
  [ -d "integrations/gemini" ] && echo -e "  ${GREEN}✓${NC} Selected integration (gemini) kept" || echo -e "  ${YELLOW}✗${NC} Selected integration missing"
  [ ! -d "integrations/todoist" ] && echo -e "  ${GREEN}✓${NC} Unselected integration (todoist) removed" || echo -e "  ${YELLOW}✗${NC} Unselected integration not removed"
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
