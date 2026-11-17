# Required quantities by product line

Francesca sets the total promised work in **Delivery details → Overview → Product lines → Edit required quantities**. Each operation included in the selected service defaults to the full source quantity. Change the amounts only where the order needs an exception. A reason is required; History records the change and keeps prior signed visit reports intact.

**Visits & tasks → Book a new appointment** determines the work for one visit. It offers only unreserved work and checks that there is stock at the customer for installation. The required amount, completed work, reservations and remaining work are separate. A dispatcher must adjust conflicting reservations before reducing a required quantity. Totals and booking inputs use up to three decimal places.

The override is stored by source line ID in the existing delivery JSONB. It survives repeat imports; an incompatible source revision requires reconciliation. No schema migration or Odoo write is required for this feature.

## Cabinet acceptance scenario

| Step | Deliver | Install | Remaining to deliver | Remaining to install |
| --- | ---: | ---: | ---: | ---: |
| Required totals | 4 | 2 | 4 | 2 |
| First visit | 4 | 1 | 0 | 1 |
| Second visit | 0 | 1 | 0 | 0 |

The first visit reports its complete planned scope. The remaining installation is part of the promise, not an incomplete result from that visit. The second visit has no delivery input. With both signed reports in History and the remaining work at zero, the dispatcher can complete the delivery.

Run the isolated PostgreSQL HTTP regression from `backoffice-backend`:

```powershell
docker compose --profile tools run --rm --no-deps -v "${PWD}/src:/app/src:ro" -v "${PWD}/test:/app/test:ro" tests npx --no-install tsx --test test/work-quantities-http.test.ts
```

For a browser fixture, use the isolated frontend origins from [the stage 10 runbook](stage10-acceptance.md#reproduce-the-isolated-visible-demo), with current source in separate Next.js build directories. Start a fresh cabinet fixture from `backoffice-backend`:

```powershell
New-Item -ItemType Directory -Force -Path '.local/quantities-browser-demo' | Out-Null
docker compose --profile tools run --rm --no-deps --name delivery-quantities-browser --publish 127.0.0.1:3011:3001 -e BACKOFFICE_TEST=1 -e ROUTE_PUBLICATION_ENABLED=true -e FRONTEND_ORIGIN=http://127.0.0.1:3010 -e CREW_FRONTEND_ORIGIN=http://127.0.0.1:3012 -v "${PWD}/src:/app/src:ro" -v "${PWD}/scripts:/app/scripts:ro" -v "${PWD}/local:/app/local:ro" -v "${PWD}/.local/quantities-browser-demo:/app/.local/quantities-browser-demo" tests npx --no-install tsx scripts/demo-route-publication.ts --quantities
```

The cabinet fixture starts without appointments. Sign in with the synthetic operator and Crew accounts in the ignored `.local/quantities-browser-demo/connection.json`. Book each visit, assign the demo crew and task template, select its member as responsible, and record customer confirmation. Submit each result in Crew with the completed checklist, a demo photo and both demo signatures. Review both visits in History and verify closure in Backoffice. The PostgreSQL schema and generated evidence remain separate from the working stand. Use `--quantities --resume` to reopen that same fixture after stopping its container, without reseeding.

Verified in installed Chrome on 16 November 2026: the operator updated the line from 4/4 to 4/2, booked both visits through the forms, and closed the delivery. Crew submitted both reports with checklist, photo and signatures using Chrome's mobile viewport. The second visit had no delivery field and only one installation. Backoffice exposed both reports in History; the completed delivery had no remaining obligations. Screenshots and redacted run results are in the ignored demo directory. This exercise uses synthetic files and signatures.

The full backend suite passed 388 tests on isolated PostgreSQL. In addition to the browser sequence, the HTTP regression confirms that unrelated rows with the same SKU remain unchanged, concurrent bookings cannot reserve the same remainder twice, and finishing the second visit preserves the first signed report exactly.
