# Local line services and work-time demo

`scripts/demo-line-work-times.ts` starts a separate Backoffice API on host port **3013** for a frontend on **3010**. It creates uniquely named application and mock-source schemas in the existing isolated `delivery_backoffice_test` and `odoo_mock` databases. It never connects to customer Odoo or changes an existing schema.

The three fictional customers use the first three verified Catania building references in `local/public-demo-addresses.json`. These coordinates do not confirm unloading entrances. All three pickings contain the same synthetic SKU, with different sales orders and physical move IDs. Source service and estimated duration are NULL.

| Picking | Local service | Quantity | Local minutes per unit | On-site minutes |
| --- | --- | ---: | --- | ---: |
| DEMO/LINE-TIMES/1 | Delivery and installation | 2 | 10 delivery + 20 installation | 60 |
| DEMO/LINE-TIMES/2 | Delivery only | 3 | 15 delivery | 45 |
| DEMO/LINE-TIMES/3 | Collection only | 1 | 25 collection | 25 |

Setup uses normal authenticated HTTP import, service and work-time endpoints. It verifies that a second import preserves local choices, that Nearby work finds all three jobs within 5 km including the anchor, and that the route totals **130 minutes on site**. A temporary rate change produces 140 minutes and a return 10 minutes later; setup restores 130 minutes before leaving the server running.

Travel times are local approximations. Google and Geoapify providers are explicitly disabled in this demo. Crew, vehicle, driver and working hours remain unassigned, so feasibility correctly reports insufficient data. The route is a draft and is not published.

## Start

Use the main isolated Docker stand with its database already running. The `tests` service supplies the local mock-source owner secret required to create only the new fixture schema. The tools image must have current dependencies. Read-only source and script mounts use current code without rebuilding or changing the main backend image.

Create `.local/line-work-browser-demo` with access restricted to the current user and SYSTEM before starting; the private connection manifest contains newly generated demo passwords. Never print that manifest in logs or commit it.

From `backoffice-backend`, in PowerShell:

```powershell
docker compose --project-name delivery-backoffice `
  --file compose.yaml --file .local/geocoding-tests.compose.json --profile tools `
  run --detach --rm --name delivery-line-work-browser-demo --no-deps `
  --publish '127.0.0.1:3013:3001' `
  --env BACKOFFICE_TEST=1 `
  --env FRONTEND_ORIGIN=http://127.0.0.1:3010 `
  --env CREW_FRONTEND_ORIGIN=http://127.0.0.1:3012 `
  --env ROUTE_PUBLICATION_ENABLED=false `
  --volume "${PWD}/src:/app/src:ro" `
  --volume "${PWD}/scripts:/app/scripts:ro" `
  --volume "${PWD}/test:/app/test:ro" `
  --volume "${PWD}/.local/line-work-browser-demo:/app/.local/line-work-browser-demo" `
  tests node --import tsx scripts/demo-line-work-times.ts
```

The private `.local/geocoding-tests.compose.json` image override used for this local session selects `delivery-odoo-customerdev-tools:0.1.0` as the `tests` image. It changes the image only; the service still uses the main stand's isolated mock/test database connections. If using an up-to-date main tools image instead, omit that override file.

Inspect the named container's logs for `ready: true` and `setupStatus: ready`. Configure the separate frontend's API URL as `http://127.0.0.1:3013/api` and serve it on port 3010.

- `.local/line-work-browser-demo/connection.json`: exact owned schema names, demo admin/operator credentials, delivery IDs and route ID.
- `.local/line-work-browser-demo/result.json`: verification results without credentials.
- `http://127.0.0.1:3013/api/health`: API health.

## Resume

After the named demo container has stopped, repeat the same command with `--resume` appended after the script name. Resume validates and reuses the manifest's exact two schemas. It does not reseed data, rotate passwords, rerun setup verification or apply migrations. A fresh start refuses to overwrite an existing manifest.

The schemas and files intentionally survive server shutdown. Do not reset the shared databases or remove volumes to restart this demonstration.
