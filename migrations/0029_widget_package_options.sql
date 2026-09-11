PRAGMA foreign_keys = ON;

-- ═══════════════════════════════ Widget package fine-tuning options ══════
--
-- The Studio's second layer of customization, beyond design/variant/size/
-- elements (0028): accent color, corner shape, frame weight, shadow, text
-- scale, alignment, a custom heading line, and whether the freshness line
-- shows. Stored as one JSON object because the vocabulary is the embed
-- script's to evolve (same policy as 0028 — validated in src/widget.js,
-- unknown values degrade to defaults, never fail a request).

ALTER TABLE widget_packages ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';
