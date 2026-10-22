# DESIGN.md | Oovi visual identity (living document)

## Rule 1: tokens are the brand
`src/ui/tokens.css` is the **only** place brand values live. To rebrand,
edit that file | never hardcode a color, font, or z-index in `style.css`
or components. New UI code uses `var(--oovi-*)` directly; the old
`--studio-*` names in `style.css` are aliases, not values.

## Tokens
| Group | Tokens | Notes |
|---|---|---|
| Brand | `--oovi-brand / -strong / -soft / -line`, `--oovi-logo-a/b` | Indigo primary; logo mark keeps its two-stop gradient (brand mark, not UI chrome) |
| Surfaces | `--oovi-bg / -surface / -surface-2` | Page / cards / sunken inputs |
| Ink | `--oovi-ink / -ink-2` | Text / secondary; UI labels never below 12px (`--oovi-text-xs`) |
| Lines | `--oovi-line / -line-strong` | Borders, dividers, dashed drop zones |
| Status | `--oovi-ok / -warn / -bad` | Success, unsaved-saving, errors |
| Workspace | `--oovi-workspace / -workspace-dot` | Dark dotted canvas surround so the white artboard pops |
| Code | `--oovi-code-bg / -code-ink` | JSON / pipeline readouts stay dark mono |
| Type | `--oovi-font-ui / -font-mono`, `--oovi-text-xs/sm/md/lg/xl` (12/13/14/16/20) | System stack + Cascadia/Consolas; no webfont dependency. UI body ≥13px, labels ≥12px. Measured AA: brand-on-white 6.3:1, ink-2-on-white 4.8:1, white-on-brand 6.3:1 |
| Spacing | `--oovi-sp-1…6` (4/8/12/16/20/24px) | 4px base; adopted by all new code |
| Radius | `--oovi-r-sm/md/lg/pill` (8/12/16/999px) | Small controls → cards → pills |
| Elevation | `--oovi-shadow-sm/lg/pop` | Cards / artboard+dialogs / floating dark pill |
| Motion | `--oovi-dur-fast/med` (120/200ms) | Hover/accordion only; no decorative animation |
| Layering | `--oovi-z-dock/toast/ctx/preview` | Dock < toasts < context bar < preview exit |

## Deliberate restraint
No heavy gradients (logo mark excepted), no glassmorphism, no oversized
radii on data surfaces (JSON/debug stay square-ish dark wells). States:
hover = surface-2, active/selected = brand-soft + brand-line border
(+ accent bar on rail tabs), disabled = Bootstrap `opacity`, focus = 2px
brand outline + 1px offset. One accent family: brand indigo drives
primary buttons (Bootstrap `--bs-btn-*` overridden), selection paint,
links of emphasis, and the logo's first stop. Save status is a quiet
dot + word (Saved/Saving…/Unsaved/Error). Motion capped at
120–200ms tokens, killed entirely under `prefers-reduced-motion`.

## Staged migrations (Goal 8)
- Pre-existing padding/margin/radius literals → spacing/radius tokens.
- Dead rules: light-dot `.canvas-area` background (`#d6dae4`), old
  `.rail-*` / `#studio-accordion` selectors, literal `z-index: 5`.
- No dark mode (explicitly out of scope).
