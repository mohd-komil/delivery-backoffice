# Demonstration for Gianluca — 10 November 2026

This additive fixture creates two new deliveries in the isolated local application database. It does not write to Odoo, reset existing deliveries, or manufacture visit results. All recipients, orders and products are fictional. Public Catania addresses and building coordinates come from `local/public-demo-addresses.json`; they do not confirm an unloading entrance or a real delivery to those venues.

## Preparation

From `backoffice-backend`, with the existing local Docker database running:

```powershell
docker compose --profile tools run --rm --build tools npm run demo:gianluca -- --apply
```

The first run inserts two records under `source_instance=gianluca_demo`; subsequent runs insert zero and preserve dispatcher edits, appointments, results and history. It requires the exact isolated database `delivery_backoffice`, PostgreSQL server port 55432 and non-production tooling. `--test` instead targets `delivery_backoffice_test`. There is deliberately no reset option.

| Reference | Delivery ID | Order and line | Required work |
| --- | --- | --- | --- |
| DEMO/GIANLUCA/0001 | e2da8ac2-102d-4a74-a942-1706085fa401 | SO/9201, line 920011 | Deliver 2 chairs and install 2 |
| DEMO/GIANLUCA/0001 | same delivery | SO/9202, line 920021 | Deliver 1 chair; no installation |
| DEMO/GIANLUCA/0002 | e2da8ac2-102d-4a74-a942-1706085fa402 | SO/9203, line 920031 | Deliver 1 chair at another address |

All lines use the same product/SKU GI-CHAIR. Their order and source-line identities must stay separate. The first delivery is DEMO Sofia Romano at Piazza San Francesco d'Assisi 3, Catania CT 95124; the second is DEMO Luca Conti at the Castello Ursino public reference in Catania CT 95121.

Contact phones `+39 000 000 9201` and `+39 000 000 9202` are deliberately fictional, non-dialable demonstration values. They satisfy the existing requirement that a delivery must include a contact phone before an appointment can be booked.

## Presentation flow

1. In Backoffice find DEMO/GIANLUCA/0001 in Inbox to plan. Show its two orders, line service types, nearby second delivery and the 90-minute initial work estimate. Road travel is still an estimate, not a Google road calculation. Reuse the stand's existing warehouse/start point when showing Routes.
2. Book an appointment, assign an available crew and vehicle, name the responsible participant and record customer confirmation through the normal Backoffice controls. Use an available time so existing bookings remain intact.
3. Sign in to Crew as the assigned responsible participant. Start the visit after confirmation. Complete the relevant checklist and finish with these quantities:

   | Line | Delivered now | Installed now | Product check |
   | --- | --- | --- | --- |
   | SO/9201, 920011 | 1 | 0 | Explain the incomplete work and attach a DEMO photo to this line |
   | SO/9202, 920021 | 1 | 0 | Everything OK; attach a separate DEMO photo |

   Use clearly labelled demonstration photos and demonstration signatures. Record a truthful scenario note such as: “Demo: one chair delivered from order 9201; the second chair remains to deliver. Installation of both chairs will take place on the return visit. Order 9202 delivered in full.”
4. In Backoffice History show the responsible participant, quantities, line-specific checks/notes/photos and both signatures. After this report the remaining work must be **1 chair to deliver and 2 to install on line 920011**, and **zero work on line 920021**. The proportional remaining work estimate is 54 minutes (3 of 5 original work units), not a measured labour duration. DEMO/GIANLUCA/0002 remains unchanged.
5. In **Issues & returns → Request return visit**, select the completed **Origin visit** and fill **Reason**, **Remaining work** and **Notes**. State the exact order/line and remaining quantities. Then use **Book appointment**, select this return request, assign qualified participants and transport, choose the responsible participant and confirm the customer. Crew must show the remaining counters. If continuing the demo to completion, report delivered 1 and installed 2 for line 920011, zero new quantities for the already completed line, complete the return checklist and provide new evidence/signatures.

## Current limit to explain

The application computes remaining work by product line and operation, and protects already recorded quantities. A booked appointment does **not yet have a structured, locked per-line work scope**. The dispatcher currently describes the return scope in the linked return request's **Remaining work** and **Notes** fields; Crew sees the delivery's remaining work. Do not present that text as an enforced “installation-only visit” allocation. Structured visit work allocation and feasibility checks remain development work.

Line notes provide the synthetic product instruction. Existing line-document upload can demonstrate a drawing or instructions if a prepared file is attached through Backoffice; this fixture does not add a new instructions feature or claim a drawing was imported from Odoo.

## Verification

```powershell
npm run typecheck
npm run lint
npm run build
docker compose --profile tools run --rm --build tools npx tsx --test test/gianluca-demo.test.ts
```

The database test owns a unique schema in `delivery_backoffice_test`. It verifies identities, services, geographic metadata, the wrong-target guard, preservation of unrelated deliveries and preservation of edits on repeat. The actual browser workflow and persistence checks are recorded below.

Preparation verified on 10 November 2026: backend typecheck, typed lint and build passed; the focused PostgreSQL test passed 1/1. After the local backup, the main seed inserted 2 rows and a repeated run inserted 0. The 20 pre-existing `odoo_mock` delivery rows retained their original combined checksum `2ce20bc95aa9f756ce7d5a5227813c54`. The fixture's subsequent appointments and results are deliberately created through the normal Backoffice/Crew flow.

## Observed demonstration state — 10 November 2026

Planning, customer confirmation, the partial report and return planning were completed through the normal authenticated Backoffice and Crew interfaces in Chrome. Database reads independently confirmed the saved state; no result or signature was inserted directly into the database. All times below are Europe/Rome (UTC+01:00).

- First visit: `c6a45b80-16bb-4cc2-b5bb-05ffcd0a6fc1`, booked 10 November, 14:30–16:00, assigned to Catania Due with Matteo Ferraro responsible. Matteo submitted the result at 15:02; the visit is completed while the delivery remains open.
- Result: `d8d5c0bb-e873-41ee-af1e-25437c89c53a`, recorded as `crew_frontoffice`. The three first-visit checklist items were completed. Backoffice History displayed the report, product checks, quantities, linked photos and both drawn demonstration signatures.

| Order / line | Delivered in first report | Installed | Product check | Work still required |
| --- | --- | --- | --- | --- |
| SO/9201 / 920011 | 1 of 2 | 0 of 2 | Problem, with a note explaining the missing chair and deferred installation | Deliver 1; install 2 |
| SO/9202 / 920021 | 1 of 1 | Not required | Everything OK, with its own note | None |

The same clearly labelled `DEMO chair delivered.png` illustration was uploaded separately for each line. File `4ad71e98-fe69-4559-a125-d93eb150e1fe` is linked to 920011; `d353632d-a61f-4e9f-a539-59661ba935cf` is linked to 920021. Both records are ready, and both physical files exist in Docker storage at 9,170 bytes. Their identical content is intentional teaching evidence, not two real delivery photographs. The customer signer name explicitly identifies a test signature; the report summary also states that all photos and signatures are demonstration evidence.

Return request `074d746d-c23b-4173-a44c-53683e0c4748` links back to the first visit. Its **Remaining work** explicitly says to deliver 1 chair and install 2 on SO/9201, line 920011, and to perform no further delivery or installation on SO/9202, line 920021.

The linked follow-up, `7e9b7dd1-9bfd-4505-a9c8-37c9b91bcfc1`, is booked for **11 November, 10:00–11:00**, with customer confirmation recorded. It is assigned to **Assembly Studio with Simone Lo Presti as its only participant and responsible person**. The six tasks are Check products, Check quantity, Check integrity, Assemble, Clean work area and Remove packaging. The Assemble task requires Furniture assembly: Catania Due's three participants were unavailable for selection because they lack that skill, so an already qualified participant was selected without changing anyone's skills.

The company **Messina · Fiat Ducato (DEMO-ME-01)** and Simone as driver are reserved for **09:45–11:15**, including the manually allowed outbound and return time. Allocation `8ffd295d-2ec5-4417-916a-9c78c29e508c`, participant/crew reservations and transport reservations are persisted. These timings remain manual estimates; they are not road-based travel or full working-hours feasibility checks.

After signing in normally as Simone, Crew showed **Upcoming (1)** with the 11 November follow-up. Its product cards showed **Delivery remaining 1** and **Installation remaining 2** for line 920011, and **Completed** for line 920021. The previously empty **Overview → Local notes & instructions** field was then filled with the explicit return date, order/line and remaining quantities and saved using **Save instructions**. Crew **Refresh** displayed that text under **Instructions**. These are delivery-level instructions, not a locked appointment work allocation.

The follow-up is deliberately **not started or completed**, so its remaining work can be shown live. DEMO/GIANLUCA/0001 is at version 22 with two visits; DEMO/GIANLUCA/0002 remains version 1 with no appointments or results. A final Backoffice History check still showed the original report and both signatures. A read-only database check confirmed the original quantities and photo links, signed status for both signatures, and the original report's unchanged instructions snapshot (its notes remain null). The later live delivery instructions therefore did not rewrite the earlier report snapshot.

Browser evidence is saved in [05-crew-return-remaining.png](../.local/browser-evidence/gianluca-demo-20261110/05-crew-return-remaining.png) and [06-final-history.png](../.local/browser-evidence/gianluca-demo-20261110/06-final-history.png). After the final instructions update, all 20 pre-existing `odoo_mock` delivery rows still match checksum `2ce20bc95aa9f756ce7d5a5227813c54`, including their versions and stored histories.

Open Backoffice at <http://127.0.0.1:3000/> and select DEMO/GIANLUCA/0001 to show **History** and the planned return. In Crew, use the assigned participant's existing local account and open the [first visit](http://127.0.0.1:3002/visits/c6a45b80-16bb-4cc2-b5bb-05ffcd0a6fc1) as Matteo or the [follow-up](http://127.0.0.1:3002/visits/7e9b7dd1-9bfd-4505-a9c8-37c9b91bcfc1) as Simone. Account passwords remain only in the ignored local account manifests; this document does not copy them.
