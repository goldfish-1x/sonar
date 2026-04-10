---
description: Delete the .sonar/ map and start fresh.
allowed-tools: Bash
---

# /sonar reset

Delete the entire `.sonar/` directory and all cached understanding. Use when the map is too stale or corrupted to update incrementally.

## Protocol

1. **Check map exists.** If no `.sonar/` directory, report "No Sonar map found. Nothing to reset."

2. **Confirm with user.** Before deleting, report what will be removed:
```bash
echo "Files to remove:"
find .sonar -type f | wc -l
echo "Total size:"
du -sh .sonar
```

3. **Delete the map:**
```bash
rm -rf .sonar
```

4. **Report:**
```
Sonar map deleted. Run /sonar crawl to rebuild.
```
