/**
 * VidRec LE demo scene — PUBLIC truemarks.ai marketing pages only.
 *
 * Every narration claim is lifted from the live page copy
 * (truemarks.ai home + /vidrec-le). Do not add claims that are not
 * on the site.
 *
 * `narration` is what `say` speaks (spellings tuned for TTS);
 * `caption` is what the burned-in subtitle shows (falls back to narration).
 */
export default {
  product: 'vidrec',
  title: 'TrueMarks VidRec LE',
  steps: [
    {
      narration:
        'This is TrueMarks: forensic media intelligence from Burtson Labs, and the first forensic video platform shipping with agentic AI on board.',
      caption:
        'TrueMarks — forensic media intelligence. The first forensic video platform with agentic AI on board.',
      action: { goto: 'https://truemarks.ai/' },
    },
    {
      narration:
        'Two tools cover one workflow. Vid Rec L E is the worksheet side: capture, document, verify.',
      caption:
        'Two tools, one workflow. VidRec LE is the worksheet side: Capture. Document. Verify.',
      action: { scrollToText: 'Two tools, one workflow.' },
    },
    {
      narration:
        'Vid Rec L E turns digital video recovery into a guided, signed, court-ready workflow, from scene arrival to disclosure.',
      caption:
        'VidRec LE: digital video recovery as a guided, signed, court-ready workflow — scene arrival to disclosure.',
      action: { goto: 'https://truemarks.ai/vidrec-le' },
    },
    {
      narration:
        'Every recorder make and model gets a guided worksheet, with time calibration anchored against NIST, offset tracking, and drift notes.',
      caption:
        'A guided worksheet for every recorder make and model — NIST-anchored time calibration, offsets, drift notes.',
      action: { scrollToText: 'What teams can do.' },
    },
    {
      narration:
        'Calibration photos captured in the field tie straight to the worksheet, and one-click PDF reports embed signatures and hashes for disclosure.',
      caption:
        'Field calibration photos tie to the worksheet; one-click PDF reports embed signatures and hashes.',
      action: { scrollToText: 'Court-ready reports' },
    },
    {
      narration:
        'An append-only chain of custody records every edit and export, team workspaces scope access by role, and the field-ready P W A works offline.',
      caption:
        'Append-only chain of custody. Role-scoped team workspaces. A field-ready PWA that works offline.',
      action: { scrollToText: 'Field-ready PWA' },
    },
    {
      narration:
        'An on-board forensic assistant, grounded in the Vid Rec manual, cites the manual section on every answer. Request a pilot at truemarks dot A I.',
      caption:
        'An on-board assistant grounded in the VidRec LE manual cites its sources. Request a pilot at truemarks.ai.',
      action: { scrollToText: 'Modernize the DVR worksheet workflow.' },
    },
  ],
};
