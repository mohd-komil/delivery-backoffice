# Visit booking and participant availability — 2026-11-10

Booking now separates **Visit purpose** from **Date & time**. Regular visits have no return link. Return visits require a requested return; a sole open request is selected automatically. Its remaining work, original visit date and notes are shown before booking. Planned/resolved requests are excluded. The existing Europe/Rome date pickers, DST validation, request receipts and optimistic version checks remain in use.

The shared participant chooser in **Assign crews & task snapshots** and **Visit staffing** defaults to **Available**, as requested by Komil, so eligible people for the visit time and required skills appear immediately. It also offers All, Busy, Missing skills and Selected, with counts. Filters may overlap: a busy participant may also lack skills. Available uses the same eligibility rules as the checkboxes, including retained participants in an existing assignment. Busy includes overlapping work or assignment to another crew on this visit. Selected people outside the current filter remain visible and removable. Backend authorization, skills and overlap checks remain authoritative.

This is a frontend improvement; it does not add structured line/operation/quantity allocation to appointments. Return-request text still describes the remaining scope. There are no migrations or backend changes.

## Validation and local runtime

- `npm run typecheck`, full typed `npm run lint` and `npm run build` passed.
- `npm test`: 136/136 passed; the subsequently added `node --import tsx --test test/appointment-purpose.test.ts` passed 3/3, with scoped typed lint. Production build typechecking includes this new test.
- Focused booking/refresh regressions passed 12/12, including DST and uncertain retry receipts. Participant/staffing/skills regressions passed 25/25.
- Chrome, existing Docker API and DEMO/GIANLUCA/0001: new booking dates survived Refresh with panel scroll 1624 unchanged. Assemble showed 19 missing skills and Simone busy in another assigned crew. Removing a selected person outside the filter worked; availability Refresh retained the filter and remaining selections. Existing Assembly Studio staffing showed one available qualified participant, Simone; Refresh retained the filter and typed reason.
- Light/dark and 320 px layouts inspected. At 320 px document scroll width was 320 and panel-body client/scroll widths were both 309. Viewport and original Light theme restored. Browser warning/error log empty. Reduced motion follows the existing DeliveryPanel MotionConfig; filter chips disable transitions under reduced-motion preference.
- Browser drafts were discarded; no appointments, assignments or demo results were saved during verification.

Build with `npm run build`, then `npm start` at http://127.0.0.1:3000. Backend Docker remains at http://127.0.0.1:3001/api and Crew at http://127.0.0.1:3002.

Evidence: [booking form](screenshots/appointment-purpose.png), [participant filters](screenshots/visit-participant-filters.png).

Follow-up: Available is now the initial filter. Existing regression coverage was updated to assert it without clicking a filter; 25 focused participant/staffing/skills tests, typecheck, typed lint and production build passed. Participant checkbox identity is retained when a selected person becomes unavailable after refresh. Chrome verified the default in both initial assignment and existing staffing, including an empty qualified list with selected people still removable. The user's original open draft was left intact; a separate tab shows the new build. [Default filter evidence](screenshots/available-default.png).
