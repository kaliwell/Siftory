# Renderer i18n baseline retirement

## Outcome

The renderer visible-text baseline is reduced from 236 permitted entries covering 235 current finding groups to zero. User-facing text in the affected image search, media search, vector maintenance, asset library, remote terminal, settings, and status surfaces now routes through the translation layer.

## Guardrails

- `i18n:baseline-prune` can only remove resolved baseline entries. It refuses to run when a new or expanded hardcoded-text finding exists.
- The static gate now requires every literal renderer `t(...)` key to have an explicit `zh-CN` dictionary entry, preventing English fallback from masquerading as completed migration.
- Intentional technical tokens such as DINO, CLIP, units, hash names, dimensions, shortcut chords, and internal metric abbreviations are excluded through a narrow tested allowlist and patterns rather than grandfathered debt.
- The repository baseline is asserted to remain empty.

## Verification

- Static visible-text gate: 0 grandfathered groups.
- Literal renderer translation coverage: no missing `zh-CN` keys.
- Translation and interpolation fixtures cover asset, status, hash, SSH, media-search, and vector-maintenance messages.
- The bilingual UI matrix passes six locale, DPI, viewport, and secondary-work-area combinations using isolated temporary user data.

The development UI smoke no longer requires local DINO/CLIP model fixtures. Model presence remains mandatory for the offline packaged-resource smoke, while the renderer-only bilingual matrix stays synthetic and does not inspect real user model or media data.
