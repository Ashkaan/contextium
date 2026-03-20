#!/usr/bin/env bash
set -euo pipefail

# Contextium Installer
# Usage:
#   Fresh install: curl -sSL https://raw.githubusercontent.com/Ashkaan/contextium/main/install.sh | bash
#   Update:        ./install.sh update

REPO="https://github.com/Ashkaan/contextium.git"
VERSION="v1.0.0"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${BLUE}┌─────────────────────────────────────────┐${NC}"
  echo -e "${BLUE}│         ${GREEN}Contextium${BLUE}                      │${NC}"
  echo -e "${BLUE}│    Give your AI an operating system     │${NC}"
  echo -e "${BLUE}│              ${VERSION}                     │${NC}"
  echo -e "${BLUE}└─────────────────────────────────────────┘${NC}"
  echo ""
}

init() {
  banner

  # Ask for directory name
  read -p "Directory name for your Contextium repo [contextium]: " DIR_NAME
  DIR_NAME="${DIR_NAME:-contextium}"

  if [ -d "$DIR_NAME" ]; then
    echo -e "${YELLOW}Directory '$DIR_NAME' already exists. Use './install.sh update' inside it to update.${NC}"
    exit 1
  fi

  echo -e "${BLUE}Cloning Contextium template...${NC}"
  git clone --depth 1 "$REPO" "$DIR_NAME"
  cd "$DIR_NAME"

  # Remove upstream history and reinitialize
  rm -rf .git
  git init
  git add -A
  git commit -m "Initial Contextium setup from ${VERSION}"

  # Add upstream for future updates
  git remote add upstream "$REPO"

  # Set up merge strategy for protected paths
  git config merge.ours.driver true

  echo ""
  echo -e "${GREEN}Contextium initialized in ./${DIR_NAME}${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. cd ${DIR_NAME}"
  echo "  2. Open your AI agent (claude, cursor, codex)"
  echo "  3. Say: \"let's onboard\""
  echo ""
  echo -e "${BLUE}Your AI will walk you through a 5-minute setup.${NC}"
}

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

# Route to the right mode
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
