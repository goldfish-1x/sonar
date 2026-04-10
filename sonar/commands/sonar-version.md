---
description: Show installed Sonar version, git commit SHA, and whether an update is available from the marketplace.
allowed-tools: Bash, Read
---

# /sonar version

Show the current Sonar version and check for updates.

## Protocol

1. **Read installed version from plugin manifest:**
```bash
cat "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"
```

2. **Read installation metadata** (version, gitCommitSha, installedAt, lastUpdated):
```bash
node -e "
try {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const f = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const entries = Object.entries(d.plugins || {})
    .flatMap(([k, v]) => (k.includes('sonar') ? (Array.isArray(v) ? v : [v]) : []));
  if (entries.length) {
    const e = entries[entries.length - 1];
    console.log('installed_version:', e.version || '?');
    console.log('git_sha:', e.gitCommitSha || '?');
    console.log('installed_at:', e.installedAt || '?');
    console.log('last_updated:', e.lastUpdated || '?');
    console.log('install_path:', e.installPath || '?');
  } else {
    console.log('(install metadata not found)');
  }
} catch(e) { console.log('(install metadata not readable)'); }
" 2>/dev/null
```

3. **Check latest release on the public repo:**
```bash
gh api repos/goldfish-1x/sonar/commits/main \
  --jq '"\(.sha[0:7]) — \(.commit.message | split("\n")[0])"' 2>/dev/null \
  || echo "unavailable (no network or gh not authenticated)"
```

4. **Compare installed SHA vs latest remote SHA:**
   - If the installed `gitCommitSha` (first 7 chars) matches the latest remote SHA → up to date
   - If they differ → update available

5. **Format output:**

```
Sonar v{version}
  Installed:    {installedAt}
  Last updated: {lastUpdated}
  Commit SHA:   {gitCommitSha[0:7]}
  Install path: {installPath}

Remote (goldfish-1x/sonar @ main):
  Latest commit: {sha} — {message}

Status: ✓ Up to date
  — or —
Status: ↑ Update available — run `claude plugin update sonar` to upgrade
```

6. **If `gh` is unavailable or network fails**, skip the remote check and show:
```
Sonar v{version}
  Installed:    {date}
  Last updated: {date}
  Commit SHA:   {sha}

Remote check: unavailable — run `claude plugin update sonar` to check for updates
```
