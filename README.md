# /nomistakes for Claude Code

The Claude Code plugin for [Make No Mistakes](https://makenomistakes.sh), the monthly printed book of the ridiculous things we say to get AI to do what we want.

```
claude plugin marketplace add hupai/nomistakes-plugin
claude plugin install nomistakes@nomistakes
```

Requires Node.js 20 or newer. Type `/nomistakes:nomistakes` in a session. On first use, open the connection link and enter the code yourself to approve this installation. Then pick one of your actual messages. The plugin extracts that moment from the pinned local session and uploads a signed private draft. You review the draft on the website before requesting publication. No full session, tool output, or private reasoning is uploaded. Use `/nomistakes:nomistakes doctor` for setup diagnostics and `/nomistakes:nomistakes resume` after an interrupted connection or submission.

To disconnect, run the plugin's `scripts/submit.mjs --disconnect --tool claude-code`, or use your private connection link. Credentials are per website and tool, stored outside the plugin in `~/.config/nomistakes` (or your XDG config directory); upgrades preserve them. The production origin for this release is in `plugins/claude-code/scripts/config.json`. Do not set a development override when submitting to production.

Codex users: `curl -fsSL https://makenomistakes.sh/install-codex.sh | sh`

This repo is generated from the app's private repo; edit the plugin there.
