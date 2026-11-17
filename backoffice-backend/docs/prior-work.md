# Work completed before Backoffice

Task 14, approved on 12 November 2026. The dispatcher may confirm prior delivered, installed or collected quantities for an exact Picking product line, with a source reference and an explanation. These are opening balances, separate from Crew reports.

## Source boundary

The customer-schema Odoo development copy does not provide confirmed delivery and installation history for the currently selected Picking lines. `stock_move.quantity`, `picked` and an order line's cumulative `qty_delivered` must not be imported as completed work for the current Picking.

For example, the inspected development record `MTO/OUT/82667` has a current demand of 20 units and a related sales order line with 40 ordered and 20 already delivered. Its current Picking is a backorder. Subtracting that order-level history again would incorrectly erase the remaining 20 units. This example establishes a mapping risk, not customer confirmation of completed work.

No source database writes are required. Unknown history remains unknown until a dispatcher confirms it; a deliberately confirmed zero is distinguishable from missing information.

## Confirmation and correction

Use the earlier-work section of an exact product line in Delivery Details. Choose the line service first. Enter quantities for the applicable operations, the source reference and an explanation; explicitly acknowledge that they belong to this current Picking line, not another Picking or the order as a whole.

`PATCH /api/deliveries/:id/prior-work` requires an authenticated Backoffice operator or administrator, the current delivery `version`, a unique `requestId`, `sourceLineId`, all three quantities in thousandths (`deliveredMilli`, `installedMilli`, `collectedMilli`), `sourceReference`, `reason` and `acknowledgeCurrentPicking: true`.

Each accepted correction replaces the line's opening balance; revisions are not added together. Previous revisions, actor, timestamp and source-line snapshot remain in History. An identical retry with the same request ID must not apply the balance twice; a different payload with the same ID must be rejected.

Confirmation is restricted to lines without active planned work or recorded local results. Cancel an empty planned visit through its normal workflow before correcting its opening balance. Existing Crew evidence and signed results are never rewritten by this action. A source identity or unit change, removed line or demand below confirmed work requires review before new planning or closure.

## Downstream behavior

The shared work rules combine confirmed prior work and effective local Crew results. Inbox, Nearby work, Routes, booking and closure must use those same remaining quantities. A delivered product with installation still outstanding can therefore receive an installation-only repeat scope.

A wholly completed, verified opening balance can satisfy the quantity and completed-visit requirement without inventing a Crew visit or signatures. Other closure blockers still apply. Actual later Crew handovers continue to follow their existing evidence and signature requirements.

## Verification

Use isolated PostgreSQL schemas for test confirmations and source mutations. Never populate the customer-copy records with invented prior-work facts merely to demonstrate the feature.

The 12 November implementation checkpoint passed backend strict typecheck, typed lint and build; the new authenticated prior-work HTTP group passed 5/5 and importer/domain/work-time regression groups passed 47/47 against isolated PostgreSQL schemas. The frontend passed strict typecheck, typed lint, production build and 234/234 tests. The covered scenarios include identical SKU on distinct order lines/Pickings, replacement corrections, idempotent retries, known zero, stale source identity/demand, prior delivery followed by a signed installation visit, and full prior-work administrative closure. A confirmation on an unrelated line does not invalidate an already-started visit.

This checkpoint does not claim browser verification or that the primary source-copy runtime has been rebuilt. Those remain part of the combined task 14/16/17 and planning-directory runtime check.
