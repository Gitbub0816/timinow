/**
 * Regenerate the native instruction-phrase table from the web one.
 *
 * `public/map.js` is the single source of truth for how Tími speaks. The iOS
 * app reads a bundled JSON copy, and the two must be identical or a driver
 * hears one voice on the phone and another in the car. Rather than ask anyone
 * to keep two files in step by hand, generate one from the other and let
 * `scripts/validate.mjs` fail the build if the copy is stale.
 *
 *   npm run sync:phrases
 */
import { writeFile } from "node:fs/promises";
import {
  INSTRUCTION_OVERRIDES,
  INSTRUCTION_PHRASES,
  MODIFIER_WORDS,
  SIDE_WORDS,
  TIMI_ANNOUNCEMENTS
} from "../public/map.js";

export const NATIVE_PHRASE_PATH = "apps/customer-mobile/Sources/TimiNowUI/Resources/instruction-phrases.json";

export function phraseTable() {
  return {
    instructionPhrases: INSTRUCTION_PHRASES,
    instructionOverrides: INSTRUCTION_OVERRIDES,
    modifierWords: MODIFIER_WORDS,
    sideWords: SIDE_WORDS,
    timiAnnouncements: TIMI_ANNOUNCEMENTS
  };
}

export function serializedPhraseTable() {
  return `${JSON.stringify(phraseTable(), null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFile(NATIVE_PHRASE_PATH, serializedPhraseTable());
  const registers = Object.keys(TIMI_ANNOUNCEMENTS).join(", ");
  console.log(`Phrase table synced to ${NATIVE_PHRASE_PATH} (${Object.keys(INSTRUCTION_PHRASES).length} maneuvers, registers: ${registers}).`);
}
