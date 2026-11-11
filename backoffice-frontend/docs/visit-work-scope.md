# Product-line services and visit work — 2026-11-10

Backoffice plans work against individual source lines. Two sales orders containing the same SKU remain separate: every selection, reservation and reported quantity uses the source line ID, not the product ID. The frontend uses the existing authenticated backend API; it does not write to Odoo or PostgreSQL directly.

## Choose the service

Open a delivery's **Overview → Product lines**. The delivery's default service applies to inherited lines. **Edit line service** can override an eligible line with delivery, delivery and installation, installation only, or collection only.

Before saving a different default, the preview lists which lines will change and which will keep their service. Explicit overrides and known services protected by recorded or reserved work are preserved. An unknown source service remains unconfirmed; select a supported service before booking its work. A legacy line with recorded work but no confirmed service still permits an explicit service decision, including during an active visit. The backend rejects a choice that would contradict recorded quantities. Selecting installation only does not fabricate a delivery record.

The **Work by product line** table separates each operation into:

| Column | Meaning |
| --- | --- |
| Total | The quantity required by the line's service. |
| Done | Actual work already recorded. |
| Remaining | Required work that has not been completed. |
| Reserved for visits | Remaining work assigned to active visits. |
| Available | Unreserved remaining work that can be booked now. |

These quantities come from the backend. A delivery already completed at the customer's address can therefore have zero delivery remaining and a positive installation remainder.

When source or legacy-visit review blocks planning, **Available** shows **Review required** and the specific reason instead of presenting a numeric remainder as bookable. The actual remaining and reserved quantities stay visible.

## Book only the work for this visit

In **Visits & tasks → Book a new appointment**:

1. Select a regular visit or an existing return request. A return request supplies its context; the structured work list determines the quantities actually planned.
2. Review **Work for this visit**. Available residual quantities are selected initially. Set an operation to zero to leave it for a later visit, or reduce its quantity to split work between visits. **Clear selection** and **Select all available work** apply to the whole list.
3. Enter the visit's date and time in **Europe/Rome**, then book it. Assign the crews, participants, tasks and transport using the existing scheduling actions.

Quantities support up to three decimal places and cannot exceed available work. Completed quantities are not selected again. Selections are maintained for every table page, including rows not currently visible. Refresh preserves the draft; if the delivery version changes, the form requires an explicit **Use latest data** before saving against the new availability.

Booking reserves the selected operations atomically. A second booking cannot reserve the same remaining quantity. Cancelling a visit releases its unperformed work; previously reported actual work remains recorded. Linking a return request does not reset quantities or replace the line's original service.

Installation may be booked before an earlier delivery takes place. Crew can start only when the required stock is already at the customer or is included in the same visit's delivery plan; a future delivery on another visit is not treated as completed. For an **installation only** line, the dispatcher must explicitly confirm that the product is already at the customer. This confirmation records planning evidence, not delivered quantities.

## Review or change visit work

For a booked visit, use **Edit visit work**, change the operations or quantities, enter a reason, and confirm. Editing can reuse that visit's own reservation, but cannot take quantities reserved by another visit.

Saving a booked visit's work list clears its customer confirmation. Check the duration, tasks, participant skills, assigned crews, transport and route plan against the changed work before recording customer agreement again. The scope editor does not automatically resize the appointment, replace resources or cancel existing assignments.

Older active visits without a structured work list show **Review and confirm work**. The dispatcher must explicitly select the remaining work and provide a reason. This review is also available for an older visit already in progress when it has no work scope or results; it preserves its actual start and existing records. A started visit with a confirmed scope cannot be rewritten through this editor. Completed historical visits are not populated with invented work plans.

The current visit displays its confirmed work and revision. New result records retain their work snapshot alongside their original source snapshot in **History**, so later delivery edits do not rewrite the submitted report. Historical results without a work snapshot are labelled accordingly.

## Crew and Routes

Crew receives the visit's explicit work limits while retaining the delivery's product context. Quantities outside the plan cannot be reported. A legacy or outdated work list requires dispatcher review; installation waiting for actual stock is identified separately.

An unbound route stop uses free remaining work. In Routes, selecting a specific appointment instead uses that visit's confirmed work and customer window. Fully reserved jobs cannot be silently added as free work through Inbox's one-click draft action; its explanation directs the dispatcher to choose the booked appointment in Routes. Route travel times remain estimates unless a separately configured road provider is used.

## Languages and verification

Work-plan labels, guidance and mapped conflicts are available in English, Italian, Russian and Uzbek. English remains the default. Recorded product names, order references and operator reasons remain as entered.

Automated checks on 2026-11-10:

```powershell
npm run typecheck
npm run lint
node --import tsx --test --test-concurrency=1 test/*.test.ts
npm run build
```

Typecheck, typed lint and the production build passed. The final complete sequential frontend suite passed **177/177 tests**, with no skipped tests. The route, Nearby and availability files changed after the full lint run also passed their focused typed-lint checks.

A subsequent UI correction makes blocked availability explicit and permits recovery of unknown legacy services while retaining recorded quantities. Its expanded `test/visit-work.test.ts` suite passed **11/11 tests**, including two added regression cases; these are included in the final 177-test run.

The work-scope regressions cover separate same-SKU order lines, available versus reserved quantities, installation-only stock confirmation, future installation booking, selections across pagination, stale drafts, explicit legacy review, safe retries, default-service protection and immutable result display. Existing calendar, Refresh, staffing, transport, directory and routing tests also passed. An earlier parallel run hit a transient Windows file-read error loading a test dependency; the affected file and the final complete sequential run passed.

## Chrome demonstration

Verified against the running Docker API on 2026-11-10 with the two same-SKU orders in **DEMO/GIANLUCA/0001**:

- Order `9201`, line `920011`: total delivery 2, delivered 1, remaining delivery 1; installation total 2, done 0, remaining 2.
- Order `9202`, line `920021`: delivery 1 completed, remaining 0, no installation obligation. Its booking inputs are disabled.
- Cancelled the old unscoped demo follow-up with a recorded reason, then booked its linked return request for **11 November, 10:00–11:00 Europe/Rome**, selecting only delivery 1 and installation 2 on line `920011`. The same crew, responsible participant and vehicle were reassigned through normal authorized screens. The previous allocation is cancelled in History.
- The saved visit is `8cb84445-1eee-46d2-be19-270f9f91135c`. Crew displays the selected work and retains the other order as “Not planned for this visit”. After the visit was started, its result form exposed quantities only for `920011`. No new result was submitted during this check.
- Refresh retained operation quantities, visit purpose and entered dates. The default-service preview protected both recorded/overridden lines. A separate old active visit showed **Review required** instead of misleading numeric availability.
- Inspected Crew at 390 px with no horizontal page overflow. Browser console checks returned no captured errors or warnings. This is browser viewport verification, not a physical phone/camera test.

The signed first-visit result, its photos and both signatures were retained; the stored result-array digest was unchanged before and after demo actions. Backend and importer images were rebuilt, the importer completed its 20-row demo scan, and both frontend production servers were started.

Evidence: [confirmed booking](screenshots/visit-work-scope-booked.png), [work and reservation table](screenshots/visit-work-scope-backoffice.png), [Crew mobile view](screenshots/visit-work-scope-crew.png).
