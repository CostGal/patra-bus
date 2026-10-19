# Learning queue

My study tracker: https://claude.ai/artifact/SJBZWER8F2n3JuCtQ8UBnP

## This week's 1–2 topics
-

## Confused me
<!-- Claude adds a term here whenever I ask for an explanation twice or say I don't get it. These become study topics. -->
- Why the location stays on the device: the phone compares its own position with the city boxes by itself, so nothing is sent anywhere (TEL-142, 2026-10-19)
- What the "Switch city?" toast does: tap = the app remembers the new city and reloads with its stops and lines; ignore = it disappears after 15 s, a 5 s hint points to Settings, and nothing changes (TEL-142, 2026-10-19)
- Same-bus rules (TEL-81): how the app decides a live and a scheduled row are the same bus. Rule A: same `vehicleCode`. Rule B, the fallback: same line and arrival within 60 s. Rule B can hide a second real bus of the same line arriving within a minute (2026-10-19)
- Code ownership and licenses (2026-10-18, TEL-1): who owns code by default, what a license is, why "All rights reserved" is the safe start, and why a public repo is not free for everyone to use. See the glossary entries: All rights reserved, License, Copyleft.

## Done — can explain it
<!-- Move a term here once I can explain it in my own words (and have filled in "My words:" in GLOSSARY.md). -->
- Explain-back gate: nobody commits or merges a change without explaining what changed, why, and how it could break, so everyone understands the app, not just the code (2026-10-12)
