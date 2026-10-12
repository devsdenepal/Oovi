# DECISIONS.md — ambiguous calls during the Oovi evolution

Conservative option wins every tie. Newest entries first.

## Goal 1 — editor chrome (canvas focus)
- **Save status without the Goal 7 project store:** dirty-flag + debounced
  localStorage draft (`oovi.draft.v1`, `{title, design, savedAt}`).
  Boot never auto-loads the draft (that is Goal 5/7 recovery UI). Goal 7
  upgrades the backend to IndexedDB projects; the status contract
  (`saved`/`saving`/`unsaved`) stays the same.
- **Zoom model:** `fit` (default, never upscales — old behavior) vs absolute
  scale 20–300%. `100%` = true pixels even if it overflows (scrolls).
  `+/-` steps ×1.25 from the current effective scale. Mode survives
  Generate/resize; window resize only re-fits in `fit` mode.
- **Lock is Fabric-level only for now:** `lockMovement*/lockRotation/
  lockScaling*` + `hasControls=false`, one history entry. It does NOT
  survive Design-JSON round-trips (`locked` is not a schema field) and is
  not yet enforced in AI patches (Goal 4) or shown in Layers (Goal 3).
- **Clear Canvas kept as a small header button** until Goal 5 adds the
  confirmation dialog. Regenerate stays in the AI dock (Goal 4 moves it
  into the assistant with confirmation).
- **Inner list scrolls kept** (layers list, JSON, pipeline tabs get
  max-height + own scroll). "No nested scrollbars" is enforced at layout
  level: each of the 3 columns scrolls exactly once.
- **UI label floor 12px** (`.panel-title` 11.5→12px, canvas hints/statuses
  11→12px). Smaller mono readouts (JSON 11px, debug 10.5px) stay — they
  are code, not UI labels.
- **Topbar tabs kept as view shortcuts** (Design→Insert tab, Code→Developer
  disclosure, Pipeline→Pipeline tab) instead of removed, to preserve the
  existing Code/Pipeline reachability.
