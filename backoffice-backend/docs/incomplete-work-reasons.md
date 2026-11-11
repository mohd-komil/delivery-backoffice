# Incomplete work per planned product operation

Implemented 2026-11-10. This extends explicit visit scopes and the existing Crew Finish endpoint; no schema migration, data reset, new infrastructure or Odoo write is needed. Existing results are not backfilled with invented reasons.

## Contract

`POST /api/crew/visits/{id}/finish` accepts `incompleteWork` alongside quantities, quality checks, photos and signatures:

```json
{
  "incompleteWork": [
    {
      "sourceLineId": 930011,
      "operation": "delivery",
      "reason": "damage",
      "note": "Second chair remained in the van."
    }
  ]
}
```

Operations: `delivery`, `installation`, `collection`. Reasons: `missing_goods_or_parts`, `damage`, `access`, `customer_refused`, `time_shortage`, `other`. `note` must be null or a trimmed string of at most 500 characters; `other` requires a nonblank explanation. Each source-line/operation pair is unique; at most 1500 pairs fit a 500-line visit.

For every operation included in the immutable visit plan, actual quantity below planned quantity requires exactly one reason. Omitted quantity entries and omitted optional operation amounts count as zero. A completed operation, an operation outside the visit plan, another source line, or an unknown line cannot carry a reason. Identical SKUs in different orders remain independent through their source-line IDs. Quality checks (`ok`/`problem`) describe condition separately and never replace an incomplete-work reason.

`INCOMPLETE_WORK_REASON_REQUIRED` and `UNEXPECTED_INCOMPLETE_WORK_REASON` are HTTP 400 domain errors. Strict input validation rejects duplicate pairs, unsupported codes and missing Other explanations. Existing quantity/stock/authorization checks remain authoritative.

New scoped results persist `incompleteWork`, including an explicit empty array when all planned work is complete. Old results without this field keep their original shape and remain readable. History receives these values through the existing authenticated delivery detail endpoint, attached to the immutable work/source snapshots, author and receipt time. Signed corrections append a new effective result, validate against the original scope and preserve prior quantities/reasons/signatures.

Only the designated current participant may finish the shared visit. Reasons are part of retry fingerprints and the signed report payload. Reusing a request/result ID with changed reasons conflicts; identical retries add neither quantities, files nor audit rows. Validation runs before private file writes. Audit records include the incomplete-operation count and immutable result reference, without copying free-text notes or drawings into generic audit metadata.

Customer absent remains the separate failure command: zero handover, required visit-level explanation, no customer signature. Normal Finish still requires photos and both signatures; a zero-quantity result must explain all planned operations. Reasons do not credit work, consume the remaining quantity or automatically resolve issues. Unperformed quantities remain available for independent repeat planning, except damage: from 2026-11-11 a damage reason or typed damage Issue holds that source line until Francesca explicitly confirms readiness with an explanation. See [product issues and readiness](product-issues-readiness.md).

## Checks

Meaningful coverage is in `test/work-scope.test.ts`, `test/crew-access.test.ts`, `test/execution.test.ts` and existing domain/transport regression tests. Scenarios cover two orders with the same SKU; partial, zero, complete and unplanned operations; collection; invalid Other notes; immutable legacy results; signed corrections; retry conflicts; real authentication/CSRF; no metadata or file writes on rejection; authenticated Backoffice History persistence; and repeat planning of only the remainder.

Run from this backend directory:

```powershell
npm run typecheck
npm run lint
npm run build
npm run openapi
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" -v "${PWD}/scripts:/app/scripts:ro" tests npm test
```

The tests verify the isolated `delivery_backoffice_test` target, apply migrations only in unique owned schemas and remove only test-owned resources. Main demo preparation is documented separately in [the same-SKU demo](demo-work-reasons.md).

Final backend verification on 2026-11-10: **213/213 tests passed**, no failures or skips, against isolated PostgreSQL through the `tests` Compose service with fresh read-only source/test/script mounts. Typecheck, typed lint, production build and OpenAPI generation passed. The full test log is `.local/incomplete-work-backend-final-20261110.log`. This verification did not mutate the main demo database or restart application containers; browser/demo acceptance is performed separately.
