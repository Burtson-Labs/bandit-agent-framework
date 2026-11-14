/**
 * Web Page skill (id `web/artifact`) — auto-activated when the task is to build an
 * HTML page / report / dashboard the user will view or save to their Bandit Stash.
 *
 * It ships NO tools; its whole job is to inject quality guidance into the system
 * prompt so self-contained HTML pages come out looking like real product
 * design — mobile-friendly, theme-aware, Lucide-iconed — instead of a raw dump.
 * The same guidance (HTML_ARTIFACT_GUIDANCE) is reused by the CLI graph sink node
 * so a page a graph saves to Bandit Stash hits the same bar.
 */
import type { SkillManifest } from '../skill-types';

/**
 * The house style for any self-contained HTML page Bandit produces. Kept as a
 * standalone export so both this skill (normal turns) and the graph sink node
 * (research→save-to-Stash turns) advise the model identically.
 */
export const HTML_ARTIFACT_GUIDANCE = [
  'When you build a self-contained HTML page (a report, dashboard, briefing, or any HTML you will save to the user\'s Bandit Stash or share), treat it as real product design, not a raw document. Deliver these by DEFAULT:',
  '- Self-contained + CSP-safe: ALL CSS in a <style> tag and ALL JS in a <script> tag — no external stylesheets, fonts, scripts, or CDNs (they are blocked). Embed images as data: URIs. Use a system font stack, no web fonts.',
  '- Mobile-first & responsive: design for a phone first, then scale up. Relative units, flexbox/grid, max-width on content, images max-width:100%. The page body must NEVER scroll horizontally — wide tables/code/diagrams scroll inside their own overflow-x:auto container. Comfortable tap targets and spacing.',
  '- Light AND dark theme: style BOTH. Default to the viewer’s system preference with @media (prefers-color-scheme: dark), drive every color from CSS variables, and add a small theme toggle that flips them. Never hard-code one background/text color that breaks in the other mode.',
  '- Lucide icons, inlined as SVG: use Lucide-style icons inlined directly as <svg> (never a CDN or icon font). Lucide convention: viewBox="0 0 24 24", fill="none", stroke="currentColor", stroke-width="2", stroke-linecap="round", stroke-linejoin="round" — currentColor makes them follow the theme automatically. Size with width/height or CSS.',
  '- Title and summary: give the page a specific <title> (under 90 characters, no file extension) and a one-sentence <meta name="description"> (under 200 characters) saying what it shows. They are what people see when the link is pasted into Slack, Teams or iMessage; when you publish, pass the same text as the title and description.',
  '- Polished by default: clear visual hierarchy, generous whitespace, one coherent accent color, subtle borders/shadows, and a readable line length (~60-75ch) for prose.',
  'These rules ARE Bandit’s house UX standard. When the user says "make it nice", "polish it", or "follow our UX guidelines", just APPLY them — do NOT ask what the guidelines are; you already have them. Reserve a brief ask_user only for something you genuinely cannot infer and that would materially change the result — a brand logo, specific brand colors, or particular imagery — and only when building something substantial from scratch. Even then, prefer to ship a strong default and offer to refine afterward. On a revision or a quick turn, do not ask — apply the guidelines and show the result.',
].join('\n');

export const webArtifactSkill: SkillManifest = {
  id: 'web/artifact',
  name: 'Web Page',
  version: '1.0.0',
  description: 'Build self-contained HTML pages with excellent, mobile-friendly, theme-aware UX.',
  instructions: HTML_ARTIFACT_GUIDANCE,
  activation: 'auto',
  triggerPatterns: [
    /\bhtml\b/i,
    /\bartifact\b/i,
    // The feature is now "Bandit Stash": "save this page to my Stash". Not a bare
    // "stash", which usually means `git stash`.
    /\bbandit\s+stash\b/i,
    /\b(save|put|add)\b[\s\S]{0,40}\b(to|in|into)\s+(my|the|your)\s+stash\b/i,
    /\bweb\s?page\b/i,
    /\blanding page\b/i,
    /\bstatic site\b/i,
    /\bmicrosite\b/i,
    /\bone[-\s]?pager\b/i,
    /\bself[-\s]?contained\b/i,
    // "build/make/create/design a <deliverable>" — a page-shaped deliverable, not code.
    /\b(build|make|create|generate|design)\b[\s\S]{0,30}\b(page|site|report|briefing|dashboard|deck|flyer|poster|resume|cv|portfolio|invoice|newsletter)\b/i,
    // "publish/share this as a <page/site/report/...>"
    /\b(publish|share|save)\b[\s\S]{0,40}\b(page|site|report|briefing|dashboard|deck|artifact)\b/i,
  ],
  tools: [],
};
