# Customer refuses to sign

When the furniture was handed over or another planned operation was performed, the responsible participant can choose **Customer refused to sign** in **Finish visit**. The report contains actual quantities for each line, a reason for the refusal, the Crew signature and completion photos. If the customer prohibits photos, choose **Customer prohibited photos** and record a separate explanation. The customer signature is absent. When no work was done because the customer was absent, use the separate **Customer absent** action.

The visit ends while the report is pending. In Backoffice, open **Decision queue → Signature refusal → Open delivery History** to see the original quantities, the reason, photos or the no-photo explanation, and the Crew signature. Choose **Review signature refusal** to accept the quantities or record a supported correction. The original report is preserved; History shows the reviewer's decision, reason and timestamp.

After review, the same case stays available under **Resolved**. A correction can reduce reported quantities on the original lines when the reservation and custody records allow it; it never edits the Crew's signed submission.

An unresolved refusal blocks delivery closure. Completing the review removes this blocker. Any remaining work, open issues or other closure blockers still apply. A refused signature cannot stand in for completion of work that was not performed.

## Isolated Chrome fixture

Start the backend below from `backoffice-backend` with its local Docker database running. Ports 3010–3012 are shared by the isolated browser demos; stop an old demo server on port 3011 before using the port for this fixture. Its separate schema and files can be reopened from its own runbook.

```powershell
New-Item -ItemType Directory -Force -Path '.local/refusal-browser-demo' | Out-Null
docker compose --profile tools run --rm --no-deps --name delivery-refusal-browser --publish 127.0.0.1:3011:3001 -e BACKOFFICE_TEST=1 -e ROUTE_PUBLICATION_ENABLED=true -e FRONTEND_ORIGIN=http://127.0.0.1:3010 -e CREW_FRONTEND_ORIGIN=http://127.0.0.1:3012 -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" -v "${PWD}/local:/app/local:ro" -v "${PWD}/.local/refusal-browser-demo:/app/.local/refusal-browser-demo" tests npx --no-install tsx scripts/demo-route-publication.ts --refusal
```

Use current source for the two Next.js apps, with the isolated origins and build folders described in the [stage 10 runbook](stage10-acceptance.md#reproduce-the-isolated-visible-demo). Demo account details and visit IDs are in the ignored file `.local/refusal-browser-demo/connection.json`. The backend prepares two booked and customer-confirmed visits through the existing API. Use `--refusal --resume` to reopen the exact saved fixture without reseeding.

| Picking | Report submitted by Crew | Expected after Francesca accepts |
| --- | --- | --- |
| DEMO/REFUSAL/0101 | Two cabinets delivered, refusal reason, demonstration photo and Crew signature | No remaining work; Francesca can close the delivery |
| DEMO/REFUSAL/0102 | One of two cabinets delivered; separate reasons for the incomplete delivery, refusal, and prohibited photographs; Crew signature | One cabinet remains available for another visit; delivery stays open |

Complete the two demo checklist items, choose the refusal mode and enter the evidence above. Verify **Pending dispatcher review** and that **Verify & complete delivery** is unavailable. Review in History using the operator account, confirm the two different closure outcomes, and check that each original report still has no customer signature. Use synthetic evidence only.

Verified in Chrome on 16 November 2026 using both signed Crew reports and the normal dispatcher account. Both visits ended with the case pending, and closure was blocked before proof review. The 0101 delivery closed after review; 0102 stayed open with one cabinet outstanding. The queue retained both resolved cases, and Crew showed the accepted decisions after reopening the visits. The result and screenshots are in the ignored demo directory.
