#!/usr/bin/env bash
set -euo pipefail

# Contextium Installer
# Usage:
#   Fresh install: curl -sSL contextium.ai/install | bash
#   Update:        ./install.sh update

REPO="https://github.com/Ashkaan/contextium.git"
VERSION="v1.0.0"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

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
      curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg 2>/dev/null
      echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list >/dev/null
      sudo apt-get update -qq && sudo apt-get install -y -qq gum >/dev/null 2>&1
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

# --- Init (fresh install) ---

init() {
  banner
  ensure_gum

  # Step 1: Name
  echo -e "${BOLD}What's your name?${NC}"
  echo -e "${DIM}Your AI will use this to personalize your experience and create your profile.${NC}"
  USER_NAME=$(gum input --placeholder "Your name" --width 40)
  if [ -z "$USER_NAME" ]; then
    echo -e "${YELLOW}Name is required.${NC}"
    exit 1
  fi
  echo ""

  # Step 2: Directory
  echo -e "${BOLD}Where should we set up your Contextium?${NC}"
  echo -e "${DIM}This creates a new folder in your current directory.${NC}"
  DIR_NAME=$(gum input --placeholder "contextium" --value "contextium" --width 40)
  DIR_NAME="${DIR_NAME:-contextium}"
  if [ -d "$DIR_NAME" ]; then
    echo -e "${YELLOW}Directory '$DIR_NAME' already exists. Use './install.sh update' inside it to update.${NC}"
    exit 1
  fi
  echo ""

  # Step 3: AI Agent
  echo -e "${BOLD}Which AI coding agent do you use?${NC}"
  echo -e "${DIM}Contextium will install the right instruction file for your agent.${NC}"
  echo -e "${DIM}You can always switch later by copying from agent-configs/.${NC}"
  AI_AGENT=$(gum choose --cursor-prefix "[ ] " --selected-prefix "[x] " \
    "Claude Code (recommended)" \
    "Cursor" \
    "Codex CLI")
  echo -e "${DIM}Selected: ${AI_AGENT}${NC}"
  echo ""

  # Step 4: Integrations
  echo -e "${BOLD}Which tools and services do you want to connect?${NC}"
  echo -e "${DIM}Contextium includes setup guides for each one. Pick only what you use —${NC}"
  echo -e "${DIM}you can always add more later. (Space to toggle, Enter to confirm)${NC}"
  echo ""

  INTEGRATIONS=$(gum choose --no-limit --height 20 --cursor-prefix "[ ] " --selected-prefix "[x] " \
    --selected="Gemini (AI research — lets your agent delegate web research)" \
    --selected="Codex (AI bulk editing — lets your agent delegate large code changes)" \
    "1Password (store API keys and credentials securely)" \
    "Google Workspace (Gmail, Calendar, Drive, Sheets)" \
    "Todoist (task management and to-do tracking)" \
    "Gemini (AI research — lets your agent delegate web research)" \
    "Codex (AI bulk editing — lets your agent delegate large code changes)" \
    "Browse (browser automation for web scraping and testing)" \
    "Windmill (self-hosted workflow automation — like Zapier but yours)" \
    "n8n (self-hosted workflow automation — alternative to Windmill)" \
    "Cloudflare (DNS, web hosting, serverless functions)" \
    "TrueNAS (NAS and Docker container management via SSH)" \
    "Home Assistant (smart home control and automation)" \
    "Autotask (PSA/ticketing for managed service providers)" \
    "NinjaOne (device inventory and remote monitoring)" \
    "QuickBooks Online (business accounting and financial reports)" \
    "Monarch (personal finance tracking and budgeting)" \
    "Strety (EOS platform — scorecards, rocks, meeting management)" \
    "Hudu (IT documentation platform)" \
    "MSPBots (MSP-specific analytics and KPI dashboards)" \
    "Garage (S3-compatible object storage for backups)" \
    "TRMNL (e-ink display dashboard for at-a-glance info)" \
    "Remote Control (access your AI from your phone)" \
    "HAPI (voice interface — talk to your AI)" \
    "VS Code (remote development tunnel)" \
    || echo "")
  echo ""

  # Step 5: Private GitHub repo
  CREATE_REPO="no"
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    echo -e "${BOLD}Want to back up your Contextium to GitHub?${NC}"
    echo -e "${DIM}This creates a private repo so your context is version-controlled and backed up.${NC}"
    echo -e "${DIM}Only you can see it — it's private by default.${NC}"
    CREATE_REPO=$(gum choose "Yes — create private repo and push" "No — keep it local for now")
  fi
  echo ""

  # --- Execute ---

  echo -e "${BLUE}Setting up your Contextium...${NC}"
  echo ""

  # Clone template
  git clone --depth 1 "$REPO" "$DIR_NAME" 2>/dev/null
  cd "$DIR_NAME"

  # Reinitialize git
  rm -rf .git
  git init -q
  git branch -m main 2>/dev/null || true

  # Copy agent config based on selection
  case "$AI_AGENT" in
    "Claude Code"*)
      cp agent-configs/claude/CLAUDE.md ./CLAUDE.md
      cp agent-configs/claude/AGENTS.md ./AGENTS.md 2>/dev/null || true
      cp agent-configs/claude/GEMINI.md ./GEMINI.md 2>/dev/null || true
      echo -e "  ${GREEN}✓${NC} Claude Code config installed"
      ;;
    "Cursor"*)
      if [ -f agent-configs/cursor/.cursorrules ]; then
        cp agent-configs/cursor/.cursorrules ./.cursorrules
      fi
      echo -e "  ${GREEN}✓${NC} Cursor config installed (basic — community contributions welcome)"
      ;;
    "Codex"*)
      if [ -f agent-configs/codex/AGENTS.md ]; then
        cp agent-configs/codex/AGENTS.md ./AGENTS.md
      fi
      echo -e "  ${GREEN}✓${NC} Codex config installed (basic — community contributions welcome)"
      ;;
  esac

  # Map integration display names to directory names
  declare -A INTEGRATION_MAP=(
    ["1Password (store API keys and credentials securely)"]="1password"
    ["Google Workspace (Gmail, Calendar, Drive, Sheets)"]="google-workspace google-auth"
    ["Todoist (task management and to-do tracking)"]="todoist"
    ["Gemini (AI research — lets your agent delegate web research)"]="gemini"
    ["Codex (AI bulk editing — lets your agent delegate large code changes)"]="codex"
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

*Fill this in during onboarding or as context develops.*
PROFILE_EOF

  # Update preferences placeholder with name
  sed -i "s/# User Preferences/# User Preferences — ${USER_NAME}/" preferences/user/preferences.md 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} Profile created for ${USER_NAME}"

  # Update integrations/README.md to only list installed integrations
  # (keeping the full README but users will see only their chosen ones in the directory)
  echo -e "  ${GREEN}✓${NC} Repo structure configured"

  # Git commit
  git add -A
  git commit -q -m "Initial Contextium setup for ${USER_NAME} (${VERSION})"

  # Add upstream for future updates
  git remote add upstream "$REPO"
  git config merge.ours.driver true

  # Create private GitHub repo if requested
  if [[ "$CREATE_REPO" == "Yes"* ]]; then
    echo ""
    echo -e "${BLUE}Creating private GitHub repo...${NC}"
    GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")
    if [ -n "$GITHUB_USER" ]; then
      REPO_NAME=$(basename "$(pwd)")
      gh repo create "${GITHUB_USER}/${REPO_NAME}" --private --source=. --push 2>/dev/null && \
        echo -e "  ${GREEN}✓${NC} Pushed to github.com/${GITHUB_USER}/${REPO_NAME} (private)" || \
        echo -e "  ${YELLOW}Could not create repo. You can do this later with: gh repo create${NC}"
    fi
  fi

  # Done
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Contextium is ready.${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${BOLD}cd ${DIR_NAME}${NC}"
  case "$AI_AGENT" in
    "Claude Code"*) echo -e "  ${BOLD}claude${NC}" ;;
    "Cursor"*)      echo -e "  ${BOLD}cursor .${NC}" ;;
    "Codex"*)       echo -e "  ${BOLD}codex${NC}" ;;
  esac
  echo -e "  ${DIM}Say: \"let's onboard\"${NC}"
  echo ""
  echo -e "  Your AI will finish the setup — communication style,"
  echo -e "  professional context, and your first knowledge domain."
  echo ""
}

# --- Update (existing install) ---

update() {
  banner

  # Verify we're in a Contextium repo
  if [ ! -f "CLAUDE.md" ] || ! grep -q "Contextium" "CLAUDE.md" 2>/dev/null; then
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

# --- Route ---

case "${1:-init}" in
  init)
    init
    ;;
  update)
    update
    ;;
  *)
    echo "Usage: $0 [init|update]"
    echo "  init   — Set up a new Contextium repo (default)"
    echo "  update — Pull latest framework updates"
    exit 1
    ;;
esac
