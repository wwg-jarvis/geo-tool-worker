# SPEC: Fix Email Template Styling (WWG-598)

## Objective

Review and fix HTML email templates in `apps/worker/src/jobs/` to ensure correct rendering,
brand-accurate colors, and mobile responsiveness.

## Files to Modify

- `apps/worker/src/jobs/notify.ts` — scan completion email (renderScanCompleteEmail, lines 13-57)
- `apps/worker/src/jobs/digest.ts` — daily digest email (renderDigestEmail, lines 15-71)

## Acceptance Criteria

1. All styles are inline — no external CSS, no class-based references
2. Accent/CTA color matches OUTRANKgeo app primary: `#7c3aed` (HSL 262.1 83.3% 57.8%)
3. Dark header uses `#0f172a` (already correct — retain)
4. CTA buttons: prominent, clearly visible, good padding
5. Unsubscribe link present in notify email (already present — retain)
6. Mobile-responsive: outer container has `width: 100%; max-width: 600px` for correct sizing on small screens
7. Score display in notify email: accent color on score matches `#7c3aed`

## Issues Found in Current Templates

| File      | Issue                                                                     |
|-----------|---------------------------------------------------------------------------|
| notify.ts | Accent color `#6366f1` (indigo-500) — should be `#7c3aed` (violet-600)   |
| digest.ts | Accent color `#6366f1` (indigo-500) — should be `#7c3aed` (violet-600)   |
| Both      | Container `max-width:600px;margin:32px auto` without `width:100%` — mobile layout breaks on small screens |

## Technical Approach

1. Replace all `#6366f1` occurrences with `#7c3aed` in both files
2. Add `width:100%` to the outer container div in both templates
3. Adjust button padding slightly for improved CTA prominence (12px 28px)
4. No structural or logic changes — styling only

## No-change Areas

- Email sending logic, Resend API calls, DB queries — untouched
- Footer/unsubscribe links — already correct
- HTML structure and escapeHtml function — retain as-is
