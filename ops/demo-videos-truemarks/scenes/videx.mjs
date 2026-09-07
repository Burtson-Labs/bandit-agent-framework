/**
 * VidEx LE demo scene — PUBLIC truemarks.ai marketing pages only.
 *
 * Every narration claim is lifted from the live page copy
 * (truemarks.ai home + /videx-le). Do not add claims that are not
 * on the site.
 *
 * `narration` is what `say` speaks (spellings tuned for TTS);
 * `caption` is what the burned-in subtitle shows (falls back to narration).
 */
export default {
  product: 'videx',
  title: 'TrueMarks VidEx LE',
  steps: [
    {
      narration:
        'TrueMarks builds examiner-first forensic video software: chain of custody by design, court-ready by default.',
      caption:
        'TrueMarks — examiner-first forensic video software. Chain-of-custody by design, court-ready by default.',
      action: { goto: 'https://truemarks.ai/' },
    },
    {
      narration:
        'Its agents are examiner-grounded. They cite their sources, run the same pipelines a forensic analyst would, and stay inside the audit trail.',
      caption:
        'Examiner-grounded agents: they cite their sources, run analyst pipelines, and stay inside the audit trail.',
      action: { scrollToText: 'The first forensic video tools with agentic AI built in.' },
    },
    {
      narration:
        'Vid Ex L E is the forensic video workspace: convert, analyze, deliver, with precise control over the bitstream.',
      caption:
        'VidEx LE — the forensic video workspace. Convert. Analyze. Deliver. Precise control over the bitstream.',
      action: { goto: 'https://truemarks.ai/videx-le' },
    },
    {
      narration:
        'Step through video frame by frame, with I, P, and B frame typing, and click to seek across the GOP timeline to visualize keyframe spacing and re-encodes.',
      caption:
        'Frame-by-frame stepping with I/P/B frame typing; click-to-seek across the GOP timeline.',
      action: { scrollToText: 'What examiners can do.' },
    },
    {
      narration:
        'Export still frames with embedded metadata and a shah 256 hash, while agentic flow pipelines rerun the same parameters and artifacts on every case.',
      caption:
        'Still-frame export with embedded metadata + sha256 hash; agentic flow pipelines rerun the same parameters every case.',
      action: { scrollToText: 'Signed audit trail' },
    },
    {
      narration:
        'Source video stays on the examiner workstation. The cloud workspace stores metadata, audit records, and exports only, under a signed, NIST-anchored audit trail.',
      caption:
        'Source video stays put — the cloud stores metadata, audit, and exports only. Signed, NIST-anchored audit trail.',
      action: { scrollToText: 'VidRec LE integration' },
    },
    {
      narration:
        'Vid Ex L E pairs with Vid Rec L E worksheets: pull case context in, push extracted stills back to the record. Request a demo at truemarks dot A I.',
      caption:
        'Pairs with VidRec LE — pull worksheet context, push stills back to the case record. Request a demo at truemarks.ai.',
      action: { scrollToText: 'See the bitstream the way an examiner needs to.' },
    },
  ],
};
