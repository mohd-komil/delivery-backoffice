# Shared planning references

Open **Catalog → Planning references** (or `/?section=planning`) with a normal Backoffice operator or administrator account. The three tabs use the existing HTTP API; no browser database connection or Google API is involved.

- **Participant availability:** dated shifts, breaks and absences, with the shared Rome date/time picker. The list defaults to Month and can switch to Day or Week. Filter by person, kind and active/archived status. Editing or archiving requires an explanation; previous versions remain in History.
- **Departure & return locations:** named locations, address, optional point and unloading entrance, verification and availability. Existing public demo points remain visibly DEMO. Disabling a point keeps its history. The route editor preserves a selected unavailable point visibly instead of silently selecting another one.
- **Work-time standards:** service, exact unit label, optional category, rates, time basis, assumptions, exclusions, examples and source. Draft standards can be incomplete. Only an available confirmed elapsed-team standard with a matching service and unit can be applied explicitly to a product line. Person-minutes are never divided by crew size.

Lists use the shared table with ten rows per page. Refresh updates data while preserving filters, pagination and open input drafts. Changed record versions require explicit latest-data review before saving. Identical uncertain command retries retain the same request ID.

In **Delivery details → product line → Edit work time → Use a work-time standard**, select the desired version and provide a reason. The catalogue loads only when the first selector opens and is shared by all product lines in that panel. The copied standard version and source appear on the line and in readable delivery History. Later catalogue edits do not rewrite these estimates or historical reports.

Delivery-level work-time adjustments add a reviewed factor and fixed allowances to the selected remaining work. Enter the source and assumptions for the allowances, then explicitly save them. A factor of 100% and zero fixed minutes are neutral starting inputs. Blank numeric fields mean unknown. These inputs can be changed as company norms are agreed.

The server multiplies the selected operation quantities by their rates, applies the factor, rounds up once, and adds fixed visit time once plus each selected operation's fixed time once. An installation-only follow-up excludes delivery allowances. No remaining work gives zero minutes. Per-line estimates show variable work, while the shared total includes the applied allowances.

Inbox treats all outstanding work as one candidate visit. Separately planned visits calculate their own scopes and each include their own visit allowance.

The estimate displays its base time, factor, fixed time, total, revision and review status. A changed destination or access instruction requires explicit review of the site adjustments. Non-neutral additions to a source-proportional estimate require confirmation that the source total excludes those additions. Routes retain manual duration choices and use the existing explicit work-and-duration review when calculation inputs change.

Routes can explicitly choose manual availability or the shared participant calendar. Shared mode retains manual inputs but does not use them; backend checks cover departure through return. Calendar and location references are displayed in feasibility and publication history. Amendments can select independent departure and return points. Backend decisions remain authoritative for unknown availability, conflicts, changed references and publication/departure gates.

Run the project checks with `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`. The focused UI regressions are in `test/planning-references.test.ts`; existing route and work-time tests cover the connected flows. PostgreSQL and real guard checks belong to the backend test suite. Runtime/browser results are recorded separately after the local stand is rebuilt.
