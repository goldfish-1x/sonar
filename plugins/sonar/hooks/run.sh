#!/usr/bin/env bash
# run.sh — resolves Node and executes a hook script
#
# Claude Code hooks run in a non-interactive, non-login shell that does not
# source .bashrc or .profile. Version managers (nvm, fnm, volta) add Node to
# PATH only when those init scripts run — so Node is invisible to hooks.
#
# This wrapper tries common install locations before giving up.
# Fails silently (exit 0) if Node is not found — hooks must not block Claude.
#
# Usage (from hooks.json):
#   bash "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" "${CLAUDE_PLUGIN_ROOT}/hooks/on-prompt.mjs"

SCRIPT="$1"
[ -z "$SCRIPT" ] && exit 0

# 1. Already on PATH — fast path
NODE=$(command -v node 2>/dev/null)

# 2. Search common install locations
if [ -z "$NODE" ]; then
  # nvm: find the highest version installed
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$NVM_DIR/versions/node" ]; then
    NVM_BIN=$(ls -d "$NVM_DIR/versions/node/"*/bin 2>/dev/null | sort -V | tail -1)
    [ -x "$NVM_BIN/node" ] && NODE="$NVM_BIN/node"
  fi
fi

if [ -z "$NODE" ]; then
  # fnm: find the highest version installed
  FNM_DIR="${FNM_DIR:-$HOME/.fnm}"
  if [ -d "$FNM_DIR/node-versions" ]; then
    FNM_BIN=$(ls -d "$FNM_DIR/node-versions/"*/installation/bin 2>/dev/null | sort -V | tail -1)
    [ -x "$FNM_BIN/node" ] && NODE="$FNM_BIN/node"
  fi
fi

if [ -z "$NODE" ]; then
  # volta
  [ -x "$HOME/.volta/bin/node" ] && NODE="$HOME/.volta/bin/node"
fi

if [ -z "$NODE" ]; then
  # asdf
  ASDF_BIN=$(ls -d "$HOME/.asdf/installs/nodejs/"*/bin 2>/dev/null | sort -V | tail -1)
  [ -x "$ASDF_BIN/node" ] && NODE="$ASDF_BIN/node"
fi

if [ -z "$NODE" ]; then
  # Common system-wide locations
  for candidate in \
    "$HOME/.local/bin/node" \
    "/usr/local/bin/node" \
    "/usr/bin/node" \
    "/opt/homebrew/bin/node"; do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi

# Still not found — fail silently so Claude is not blocked
[ -z "$NODE" ] && exit 0

exec "$NODE" "$SCRIPT"
