# Last Implementation

**Date:** 2026-09-16
**What:** Slowed voice replies to 70% of their previous speed.

The client plays neural audio at `0.7x` with pitch preserved. Browser speech
uses `0.98 × 0.7 = 0.686`, applying the same relative slowdown to its previous
rate. Server synthesis settings remain the baseline for neural audio.

**Validation:** All 24 existing speech tests passed; client lint and production
build passed. Refresh the app to load the updated voice playback settings.

Earlier stabilization and remaining hosted release checks are recorded in
[production-readiness.md](./production-readiness.md).
