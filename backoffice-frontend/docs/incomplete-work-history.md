# Incomplete work in History — 2026-11-10

Open a delivery, select **History**, and find its received Crew result. **Work recorded on this visit** now shows one row for each planned product-line operation: delivery, installation or collection. The shared table displays 10 rows per page.

Each row includes its original sales order, source line, product and unit, followed by the planned quantity, completed quantity and quantity not performed on that visit. Its outcome is **Completed**, **Partially completed** or **Not performed**. A partial or unperformed operation displays the Crew reason and optional note. The supported reasons are missing goods or parts, damaged goods, access preventing the work, customer refusal, insufficient time and another reason. Another reason requires a note.

These are facts at the time of that report. They do not pretend to be the current remaining quantities after later visits. Current remaining work and availability still come from the backend's product-line work summary and booking controls. An operation not planned for the visit never receives a failure status here.

Two orders containing the same SKU remain separate because matching uses **source line ID + operation**, never the product ID. Labels use the result's immutable source and work snapshots. Product condition checks, notes and linked photos remain in the existing **Product checks** section below the work results; condition and quantity outcomes are separate facts.

## Older reports and corrections

- An older report with a work snapshot but no per-operation reasons displays its actual quantities and explicitly says those reasons were not recorded. The application does not fill them retrospectively.
- An older report without a confirmed work snapshot displays only its reported quantities and says that no recorded plan is available for comparison. It does not infer an unperformed quantity from today's product line.
- A corrected result retains the earlier version and its **Superseded** label, reasons, notes and signatures. Each result renders its own snapshot.
- Notes are rendered as plain text. Translations are available in English, Italian, Russian and Uzbek; recorded notes and source names remain as entered.

## Verification

`test/delivery-incomplete-work.test.ts` covers two orders with the same product, partial delivery, zero installation, completed delivery, different reasons by operation and order, source renaming after reporting, superseded results and preserved signatures, escaped notes, Refresh stability, optional legacy fields, malformed reasons, note limits and all four languages. Existing History tests retain checks for customer absence and product-linked evidence.

Commands from `backoffice-frontend`:

```powershell
npm run typecheck
npm run lint
node --import tsx --test --test-concurrency=1 test/*.test.ts
npm run build
```

On 2026-11-10, typecheck, typed lint, the production build and all **181 frontend tests** passed. Browser verification of the integrated Crew-to-Backoffice demo is recorded separately with the demo, rather than inferred from these component tests.

Start the built Backoffice with `npm start` and open `http://127.0.0.1:3000/`. The existing authenticated backend and PostgreSQL are required. This feature does not use Google services or write to Odoo.
