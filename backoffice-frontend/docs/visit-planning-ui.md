# Visit booking and participant availability — 2026-11-10

## Required quantities by operation (tasks 18–19)

In **Overview → Product lines**, use **Edit required quantities** on a line that needs an exception. The selected service supplies every operation's default from the line quantity. The editor keeps the completed and reserved quantities as the minimum and requires a reason. **History** shows the actor, reason and old and new quantities. Use **Book appointment** to choose only the operations and quantities for that visit from the available balance. A regular follow-up can book the remaining balance without opening a return request.

For a four-wardrobe line with **Delivery + installation**, set delivery to 4 and installation to 2. Book 4 deliveries and 1 installation for the first visit, then book 1 installation for the second. The subsequent visit has no delivery quantity. The selected line, not its SKU, determines the required and available quantities.

## Visit transport simplification — 2026-11-13

At the user's request, Allocate visit transport and Replace visit vehicle no longer select a driver. The existing API's `driver: { kind: 'none' }` option is used for these new allocations. Existing driver snapshots remain readable in historical allocations; the empty “Driver not specified” label is omitted. Vehicle availability, reservation-window coverage, reasons, versions and retry receipts remain enforced. Routes has its separate driver/feasibility workflow; this change is limited to individual visit transport.

Typecheck, full typed lint, production build and 24 focused booking/work/vehicle tests passed; the final transport changes passed all 9 vehicle tests and scoped typed lint again. Chrome verified the rebuilt form on MTO/OUT/00697 without saving business changes. The customer-schema frontend on port 3030 now runs from `.local/odoo-integration/frontend-transport-20261113`; the ignored `frontend-runtime.json` beside that directory records its command and PID. API remains 3031. Run `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3030` from that staged directory to restart the existing build.

Booking clarification: Return visit requires an open return request linked to a completed visit with reported work. A later ordinary appointment may still schedule only remaining work without a return-request link. Edit visit work changes exact line operations and quantities within the available remainder, requires a reason and resets customer confirmation. It does not change the service type or visit date. Published-route visits use the route amendment flow.

The dated original implementation notes below precede the later structured visit-work implementation.

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

## Delivery Overview hierarchy — 2026-11-13

Overview uses the shared shadcn-style Card, CardHeader and CardContent primitives through DeliveryOverviewCard. Customer/destination, product lines and access instructions have distinct header bands, icons and 24 px section spacing. Contact details precede the address map. Default service, operation progress, work-time estimates and earlier-work records have separate surfaces. Existing forms, source review warnings and exact order-line identities remain intact.

Validation: frontend typecheck, full typed lint, 24 focused refresh/work-times/prior-work/source-review tests and production build passed. Chrome checked MTO/OUT/00697 in light and dark themes, including a 390 px viewport (panel client/scroll widths both 379 px). Overview Refresh retained an unsaved Access value and panel scroll position 3280; the draft was cleared without saving. No domain data was changed. Browser warning/error log was empty. Original light theme and desktop viewport restored.

The customer-schema local runtime is http://127.0.0.1:3030 with API http://127.0.0.1:3031/api. Build using NEXT_PUBLIC_API_URL=http://127.0.0.1:3031/api and npm run build; start using node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3030. The active isolated build path and PID are recorded in the ignored .local/odoo-integration/frontend-runtime.json.

## All Delivery Details tabs — 2026-11-13

The shared card is now DeliveryDetailCard (Card/CardHeader/CardContent), reused by Overview, Visits & tasks, Issues & returns, Documents & evidence and History. Visit crews and their scheduling controls are grouped together; responsibility, customer confirmation and active transport have distinct cards. Issues and return requests are separate. Files distinguish general documents, exact product-line documents, linked evidence and upload/replacement. History separates audit events, recorded visits, result reports and closure records. No backend/API or authorization rules changed.

Validation: typecheck, full typed lint, production build and all 256 frontend tests passed. Two existing tests now target the accessible region/card-header instead of the former section/header selectors; their behavioral assertions are unchanged. Chrome checked all four tabs at desktop size and 390 px in light/dark. At 390 px every panel had equal client/scroll width (379 px). Visits Refresh retained an unsaved responsible-participant selection and scroll 300; the selection was restored without submitting. No warning/error console entries were reported. The original light theme and viewport were restored. A separate Chrome verification tab remains open so the user's working tab can continue independently.

The updated customer-schema build runs at http://127.0.0.1:3030 using http://127.0.0.1:3031/api. The ignored .local/odoo-integration/frontend-runtime.json records the current PID/build folder and start command. The source build/run commands remain those documented above.

## Shared shadcn controls in Backoffice and Crew — 2026-11-13

All visible native selects now use the shared Popover/Command Combobox; each independent frontend owns its primitives and dependencies. Lists with at most five non-empty options omit search, while larger lists allow searching. An empty placeholder or “none” option does not count toward this threshold. Disabled records remain visible and count toward the threshold. The hidden native form bridge preserves FormData, required validation, change events and disabled choices; the backend remains authoritative.

Calendar/Popover date pickers replace native date, month and datetime selectors. Datetimes retain Europe/Rome validation and the existing explicit choice for repeated DST times. Appointment scheduling actions in Visits & tasks open a shadcn Dialog; booking remains in its structured card. Existing editor dialogs and delivery/navigation drawers animate opening and closing, preserve focus restoration and respect reduced-motion preferences.

Chrome verification covered the nested assignment dialog and Escape focus return, date/time selection, the booking draft surviving Refresh, searchable planning participants, and the Crew problem form at phone width in light/dark themes. Problem type and an unsent note survived Crew Refresh. Test drafts were cleared without saving domain changes. The physical phone camera/PWA workflow was not part of this UI change.

The customer-schema build is staged in `.local/odoo-integration/frontend-shadcn-20261113` and runs on 3030 against API 3031. Crew runs independently on 3002 against its existing backend on 3001. Restart commands and the active frontend PID are recorded in the ignored runtime manifest; Crew commands are in its README.

Validation: Backoffice typecheck, full typed lint, all 260 tests and production build passed; Crew typecheck, full typed lint, all 44 tests and production build passed. The later search-threshold/focus change additionally passed both typechecks and scoped typed lint, the focused Combobox regression and both final production builds. That regression covers five records plus a placeholder versus six records, keyboard selection, filtered-list shrink on Refresh, and fast switching between popovers without stealing focus. On a memory-constrained machine the full Backoffice test command used was `node --max-old-space-size=1024 --import tsx --test --test-concurrency=2 --test-timeout=60000 test/*.test.ts`.

Final Chrome check: Backoffice Status (three choices) and Crew Problem type (four choices) display no search field. The larger Participant list retains searchable filtering. Opening Participant immediately after Status keeps the new popup focused. No browser console errors or warnings were reported for the verified Crew flow.
