# MVP demo data

The dataset creates three address-level deliveries from two synthetic pickings in `delivery_backoffice_test`. The two deliveries from the first picking share its reference and have distinct addresses and orders. All three deliveries include `MVP-CHAIR` with the same `productId`. Each line has its own `sourceLineId` and order. Addresses and phone numbers are fictional.

Run these commands from the backend directory with the Docker environment configured.

```powershell
docker compose --profile tools run --rm --build tools npm run migrate -- --test
docker compose --profile tools run --rm tools npm run demo:pilot -- --test
```

The script verifies the connected database name and creates only missing `mvp_demo` source records. The second run prints `Inserted 0 of 3`. Existing delivery data and history are preserved. The regular `odoo_mock` import uses its own source.

| Picking | Address | Lines and services |
| --- | --- | --- |
| `DEMO/MVP/0001` | `Via DEMO Alfa 1`, Milano | `910011` covers two chairs with installation. `910021` covers delivery of the same chair from a different order. `910022` covers installation of one cabinet. |
| `DEMO/MVP/0001` | `Via DEMO Beta 2`, Sesto San Giovanni | `910031` covers collection of one chair. |
| `DEMO/MVP/0002` | `Via DEMO Gamma 3`, Monza | `910041` covers delivery of one chair. |

In the test application, assign and confirm a visit to the first address, then record the delivery of one chair on line `910011`. The remaining work for that line should be one chair to deliver and two to install. Line `910021` still has one chair to deliver. A separate visit can record installation of the cabinet on `910022` without any delivery. At the second address, collection on `910031` is tracked separately from delivery. Line `910041` in the other picking stays open.

In Backoffice, the **Items** tab allows you to choose a default service and override it per line. The plan is locked while a visit is in progress. Once the visit ends, changing the default preserves the services recorded for processed lines. **Documents & evidence** lets you attach a file to a delivery or an individual line. Crew shows documents for the assigned address and remaining quantities by operation. For a line with delivery and assembly, the assembly quantity is limited to the number of items delivered, including items handed over during the current visit.

In Crew, open **Finish visit → Product check** for the relevant line. Choose **OK** or **Problem** and, if needed, add a note of up to 500 characters. In **Completion photos**, select the line by order and line number, then take or upload a photo. You can also attach photos to the visit as a whole. Submitting the signed report preserves the check results, notes, and photo associations. In Backoffice, open **History → Product checks**. To verify the workflow, mark chair `910011` as OK and chair `910021` as Problem, and attach a different photo to each. The history should show each line's order, check result, note, and photo.

## Multi-stop route draft

Seed a new test schema for this check. Demo points A `45.4642, 9.1900`, B `45.5346, 9.2343`, and C `45.5845, 9.2744` illustrate the nearby search. Running the seed again preserves existing deliveries.

1. After partial delivery at A, verify the available balance for line `910011`. One chair should remain for delivery and two for installation.
2. Add A in **Routes**. Searching within 10 km of A shows the collection at B, about 8.6 km away. C is about 14.9 km away and appears with a 20 km radius.
3. Add C to include work from both pickings. Select the Milano demo warehouse as both the start and end point, and set departure to 09:00 Rome time. Set on-site work to 40 minutes at A and 35 at C. The demo travel durations of 30, 20, and 25 minutes produce ETAs of 09:30 and 10:30, with a return at 11:30. The total is 150 minutes.
4. Move C ahead of A. The demo travel durations of 42, 28, and 22 minutes produce ETAs of 09:42 and 10:45, with a return at 11:47. Increase on-site work at C to 45 minutes. The ETA at A becomes 10:55 and the return time becomes 11:57.

The nearby search uses straight-line distances. A demo matrix supplies the travel times in this example.

With the test PostgreSQL instance configured, run `npx --no-install tsx --test test/crew-access.test.ts test/pilot-demo.test.ts` from the backend directory for an end-to-end check. The tests create and delete their own schemas. They cover authenticated planning commands, signed results, collection closure, access to instructions, and repeat demo seeding.

Demo credentials are stored locally in `.local/demo-accounts.json` (the `admin` field) and `.local/participant-demo-accounts.json` (Crew accounts). Use the account of the participant assigned as responsible for the visit in Backoffice.
