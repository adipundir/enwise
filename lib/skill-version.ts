/**
 * Single source of truth for the published skill version.
 *
 * Bump when shipping a meaningful change to public/enwise.skill.md so
 * Claude (via whoami's `current_skill_version`) can prompt users to
 * refresh their locally-installed copy.
 *
 * Convention: YYYY.MM.DD of the publish date.
 */
export const CURRENT_SKILL_VERSION = "2026.04.27.2";
