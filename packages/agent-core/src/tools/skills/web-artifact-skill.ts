/**
 * Web Artifact skill — auto-activated when the task is to build an HTML page /
 * artifact / report / dashboard the user will view or publish.
 *
 * It ships NO tools; its whole job is to inject quality guidance into the system
 * prompt so self-contained HTML artifacts come out looking like real product
 * design — mobile-friendly, theme-aware, Lucide-iconed — instead of a raw dump.
 * The same guidance (HTML_ARTIFACT_GUIDANCE) is reused by the CLI graph sink node
 * so a published-from-a-graph artifact hits the same bar.
 */
import type { SkillManifest } from '../skill-types';

/**
 * The house style for any self-contained HTML artifact Bandit produces. Kept as a
 * standalone export so both this skill (normal turns) and the graph sink node
 * (research→publish turns) advise the model identically.
 */
export const HTML_ARTIFACT_GUIDANCE = [
  'When you build a self-contained HTML artifact (a page, report, dashboard, briefing, or any HTML you will publish), treat it as real product design, not a raw document. Deliver these by DEFAULT:',
  '- Self-contained + CSP-safe: ALL CSS in a <style> tag and ALL JS in a <script> tag — no external stylesheets, fonts, scripts, or CDNs (they are blocked). Embed images as data: URIs. Use a system font stack, no web fonts.',
  '- Mobile-first & responsive: design for a phone first, then scale up. Relative units, flexbox/grid, max-width on content, images max-width:100%. The page body must NEVER scroll horizontally — wide tables/code/diagrams scroll inside their own overflow-x:auto container. Comfortable tap targets and spacing.',
  '- Light AND dark theme: style BOTH. Default to the viewer’s system preference with @media (prefers-color-scheme: dark), drive every color from CSS variables, and add a small theme toggle that flips them. Never hard-code one background/text color that breaks in the other mode.',
  '- Lucide icons, inlined as SVG: use Lucide-style icons inlined directly as <svg> (never a CDN or icon font). Lucide convention: viewBox="0 0 24 24", fill="none", stroke="currentColor", stroke-width="2", stroke-linecap="round", stroke-linejoin="round" — currentColor makes them follow the theme automatically. Size with width/height or CSS.',
  '- Polished by default: clear visual hierarchy, generous whitespace, one coherent accent color, subtle borders/shadows, and a readable line length (~60-75ch) for prose.',
  'These rules ARE Bandit’s house UX standard. When the user says "make it nice", "polish it", or "follow our UX guidelines", just APPLY them — do NOT ask what the guidelines are; you already have them. Reserve a brief ask_user only for something you genuinely cannot infer and that would materially change the result — a brand logo, specific brand colors, or particular imagery — and only when building something substantial from scratch. Even then, prefer to ship a strong default and offer to refine afterward. On a revision or a quick turn, do not ask — apply the guidelines and show the result.',
].join('\n');

export const webArtifactSkill: SkillManifest = {
  id: 'web/artifact',
  name: 'Web Artifact',
  version: '1.0.0',
  description: 'Build self-contained HTML artifacts with excellent, mobile-friendly, theme-aware UX.',
  instructions: HTML_ARTIFACT_GUIDANCE,
  activation: 'auto',
  triggerPatterns: [
    /\bhtml\b/i,
    /\bartifact\b/i,
    /\bweb\s?page\b/i,
    /\blanding page\b/i,
    /\bstatic site\b/i,
    /\bmicrosite\b/i,
    /\bone[-\s]?pager\b/i,
    /\bself[-\s]?contained\b/i,
    // "build/make/create/design a <deliverable>" — a page-shaped deliverable, not code.
    /\b(build|make|create|generate|design)\b[\s\S]{0,30}\b(page|site|report|briefing|dashboard|deck|flyer|poster|resume|cv|portfolio|invoice|newsletter)\b/i,
    // "publish/share this as a <page/site/report/...>"
    /\b(publish|share)\b[\s\S]{0,40}\b(page|site|report|briefing|dashboard|deck|artifact)\b/i,
  ],
  tools: [],
};
