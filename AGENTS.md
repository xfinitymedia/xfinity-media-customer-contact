# Agent instructions

## Systems Map: log every live change

Xfinity Media keeps a private Systems Map that records every change made to a live system (link in the private xfinity-media repo's AGENTS.md). These rules apply to every tool (Claude, ChatGPT, Codex) and every person.

- Any change to a live system needs a change log entry: a deploy, a merged pull request, a function or database change, a NAS update, a data fix, or a settings change.
- Each entry says: the date, what changed and why, how it was deployed (from GitHub, or by hand), and what is verified and what is not.
- Put the entry under "Systems Map change log" in the pull request description, or in your final message to the owner when there is no pull request. Claude, or the daily check, copies it onto the map.
- Changes made outside GitHub must say so, and say whether GitHub has been brought back in line.
