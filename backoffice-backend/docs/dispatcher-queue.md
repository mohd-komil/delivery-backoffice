# Dispatcher decision queue

Task 17 puts operational cases in one Backoffice queue. It reuses source reconciliation, address review, Issues/readiness, effective visit reports and warehouse receipt rules. It does not create a second issue system or a new evidence-waiver policy.

## Cases and original workflows

- Source: pending imports, source eligibility and actual prior-work/active-visit scope conflicts. A legacy informational `sourceChanged` flag alone is not a new case.
- Address: remaining operational work without a usable destination point. Reading the queue never calls an external geocoder.
- Issue: open Issues and unresolved damaged-work holds. Resolving an Issue does not automatically release its readiness hold.
- Evidence: effective completed reports that need signature/photo/reference review. Failed Customer absent visits are not missing-signature disputes. Superseded reports do not reopen a case.
- Cargo: exact route, visit, source line and cargo kind after actual return. Partial receipts reduce the balance; a route closed with an exception still has a case until the underlying custody requirement is resolved.

Source-line IDs and order context distinguish identical SKUs. Original-record buttons open Delivery Details/Issues/History or the actual route workflow.

## Coordination and history

`GET /api/dispatcher/queue` accepts `status` (`open`, `resolved`, `all`), `kind`, `owner` (`all`, `unassigned`, `mine`, operator UUID) and `page`. Pages contain ten records. `GET /api/dispatcher/queue/:key` returns the case and its coordination history. `GET /api/dispatcher/owners` returns the existing dispatchers.

`PATCH /api/dispatcher/queue/:key` requires normal Backoffice authentication and Origin checks, `version` (zero before the first coordination entry), `requestId`, the displayed underlying `fingerprint`, nullable `ownerUserId`, `nextAction` and `note`. A stale case or changed coordination version must be reviewed again. Identical retries do not duplicate history.

There is no manual close button. Notes and ownership cannot approve evidence, accept Odoo changes, release damaged stock or receive goods. Status derives from the original workflow. Existing cargo ownership/actions are shown separately from a queue coordinator. If the underlying facts change, an older coordination entry is visibly stale and its immutable history remains available.

## Persistence and limits

The additive `DispatcherQueue1793701400000` migration creates coordination records and immutable command/history events. It does not rewrite deliveries or route revisions. Lists are read-only; only an explicit coordination write persists a queue record. Consequently, resolved-history rows represent cases that were coordinated, rather than inventing stored discovery events for every case ever viewed.

The local implementation has explicit scan caps. It fails visibly if those are exceeded instead of returning an incomplete scan and incorrectly declaring unseen cases resolved. Evidence reference checks use validated database records; file-byte verification remains in the existing evidence/closure and recovery controls.

The initial isolated PostgreSQL checkpoint passed 24/24 dispatcher, route-lifecycle and OpenAPI regressions, including concurrency/retries, exact source-line identity, source-vs-coordinator ownership, partial/full receipts and immutable published history. Final small projection/contract adjustments and the combined runtime check are recorded separately; no external Odoo or main-stand data was used for fabricated test cases.
