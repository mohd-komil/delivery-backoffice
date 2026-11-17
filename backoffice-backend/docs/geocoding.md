# Address geocoding without Google

Odoo remains read-only and may supply only a textual address. The application requests coordinates from Geoapify and stores the result in its own PostgreSQL database. This integration is separate from road travel-time calculation; it does not activate Google or road-routing APIs.

## Private configuration

Create a Geoapify project on the Free plan and keep its key in an ignored local file, never in a frontend environment variable, source code, image build argument, log, or Notion page:

```json
{"apiKey":"YOUR_PRIVATE_KEY","dailyLimit":100}
```

The default local file is `.local/maps/geoapify.json`. `GEOAPIFY_SETTINGS_FILE` can select another backend-only path. The settings are read when needed, so changing a valid key does not require a source rebuild. The application defaults to 100 lookup attempts per UTC day; this is a conservative local cap, separate from Geoapify's account-wide quota. Missing or invalid configuration is reported without exposing its contents.

Geoapify currently offers 3,000 credits/day on Free; a normal forward-geocoding request costs one credit. Other Geoapify products and applications sharing the account also consume its quota. Check current [pricing](https://www.geoapify.com/pricing/) and [credit costs](https://www.geoapify.com/pricing-details/) before changing the application cap. Attribution is required, including for saved results.

## Isolated Odoo Docker stand

From `backoffice-backend`, with Docker available in `PATH`:

```powershell
./scripts/docker-odoo-start.ps1 `
  -ProjectName delivery-odoo-customerdev `
  -GeocodingSettingsFile ./.local/maps/geoapify.json
```

Startup creates a private Compose override that mounts this single file read-only at `/run/secrets/geoapify_settings.json` in the backend. The key is not copied into the image or passed as an environment value. The original source configuration, its integrity manifest and database credentials stay intact. Use the same option for subsequent starts so the mount is retained. An existing override pointing at a different settings file is not silently overwritten.

After the first start, add `-ValidateOnly` to validate that configuration without rebuilding or restarting services. The integration API is `http://127.0.0.1:3031/api`; the separate Backoffice runs on `http://127.0.0.1:3030`.

## Automatic import workflow and data boundaries

The normal **Run import** action also locates eligible addresses after the source snapshot has closed. It processes new and previously imported deliveries from the active source. No **Locate address** click is required for a precise result to appear on Inbox Map. The request contains the street, city, province, postal code and country. Customer names, phone numbers, order numbers and credentials are not sent as address data.

The application accepts a single high-confidence building match automatically. Approximate or ambiguous results require review and remain labelled with their precision. A geocoded address is not a confirmed unloading entrance: confirming the unloading location is a separate operator action. Existing confirmed entrances take precedence.

Refresh and map rendering do not request geocoding. Import skips missing/placeholder addresses such as `Street example …`, records under source review, and deliveries with a current reference point, saved geocode or confirmed entrance. Identical normalized addresses share one persisted result within their source namespace. Results awaiting manual review are not requested again. Negative results and temporary failures wait for their retry time. **Locate address** remains available for an individual retry or review workflow.

Source-address changes invalidate the association; an in-flight result cannot silently attach to a changed destination. Geocoding cannot overwrite a confirmed unloading entrance. All source snapshots remain read-only from the geocoder's perspective.

Each import starts at most 20 unique address lookups within a 30-second processing budget; an already-started lookup can add its existing eight-second timeout. The shared database enforces one request per second and the configured daily cap. Overflow is retained implicitly as unlocated addresses for the next ordinary import; this does not create a background job. Provider failures or missing configuration do not turn a successful source import into a failed one. A separate **Geocoding:** diagnostic in Import history reports the outcome, skipped records and deferred work. The import response waits for this bounded phase, so its normal Backoffice data refresh includes the new points.

Map display does not require a service type. Nearby work additionally requires defined remaining work. Coordinates alone do not supply missing on-site duration, customer windows, actual warehouse locations or road-based travel times.

## Live local verification

To run the ordinary importer twice and verify that the existing target appears on the map without a Locate address request:

```powershell
./scripts/verify-import-geocoding.ps1 -ProjectName delivery-odoo-customerdev
```

This uses the normal operator session and POST `/api/imports`, checks the geocoding diagnostic, and verifies that the second import preserves the accepted address record/version. It can import current source changes and locate eligible addresses within the limits above. It does not edit Odoo or accept an approximate match. For provider-request counts, inspect the application `geocoding_budget` and `address_geocoding` records before/after; provider-stub tests are separate from this live verification.

The single-address diagnostic remains available:

```powershell
./scripts/verify-geocoding.ps1 -ProjectName delivery-odoo-customerdev
```

The default target is the existing Partner 233774 delivery. The script uses the stand's normal operator login, locates that address through the authenticated backend, repeats the request to verify cache reuse, checks the map marker, and confirms that the delivery snapshot and confirmed entrance did not change. Its first lookup may contact Geoapify and save an application cache record; it does not accept approximate results or write to Odoo. Pass `-DeliveryId` for a different explicitly selected delivery.

## Provider references

- [Forward geocoding API and confidence fields](https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/)
- [Storage and caching of geocoding results](https://www.geoapify.com/geocoding-api/)
- [Terms and attribution](https://www.geoapify.com/terms-and-conditions/)

Provider documentation was checked on 2026-11-12. Automated tests use synthetic provider responses; live verification must be recorded separately and must never be claimed from fixtures alone.

## Verified local integration — 2026-11-12

Applied `AddressGeocoding1793701300000` only to the separate customer-development application stand (and isolated test databases). In Chrome on port 3030, the normal Backoffice **Locate address** action for Partner 233774 / `MTO/OUT/00697` resolved the supplied text to **Via Francesco Faranda, 19, 98123 Messina ME, Italy**. Geoapify returned a building match, confidence 1, at latitude **38.1868651**, longitude **15.5506176**. The result was automatically accepted as an address point, not an unloading entrance.

Authenticated API verification then confirmed one map marker out of 790 deliveries, 789 missing locations, and repeated lookup reuse of cache record version 2. PostgreSQL contains one accepted cache record and records one application provider attempt. A separate preflight provider call had verified the real response before deployment. No entrance was created; all 790 delivery JSON snapshots, IDs and versions retained their pre-deployment checksums. No Odoo writes were made.

Verification: backend strict typecheck, typed lint, builds and **312/312 tests** passed; Backoffice typecheck, typed lint, both production builds and **224/224 tests** passed. The small Crew label/attribution compatibility change passed typecheck, typed lint, build and **7/7 route tests**. Crew was not launched for this stand. The real Chrome check is separate from these synthetic automated tests.

The active generated Backoffice build is `../backoffice-frontend/.local/odoo-integration/frontend-auto-geocoding`; its runtime manifest is `../backoffice-frontend/.local/odoo-integration/frontend-runtime.json`. From that generated directory, restart with `node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3030`. It was built with API port 3031. Private API-check evidence is stored under the customer-development stand's `.local` directory.

Remaining data limitation: service type and work estimates are still unknown for this delivery. Geocoding makes its marker available; it does not invent the services needed for Nearby work or the inputs needed for route scheduling.

## Automatic import verified — 2026-11-12

Rebuilt and started the separate Odoo integration API and Backoffice with automatic geocoding. No additional database migration was needed. Two authenticated POST `/api/imports` requests each succeeded with 790 processed deliveries: 1 already mapped, 789 invalid/placeholder addresses, 0 new lookups and 0 deferred. The selected geocoding record remained at version 2; the provider budget remained at 1. All delivery JSON/ID/version checksums and the geocoding cache were unchanged, and no unloading entrance was created. The verification never called Locate address and never wrote to Odoo.

Chrome showed the new Geocoding diagnostic in Source sync and the retained Partner 233774 marker on Inbox Map (1/790). New-address behavior was tested separately with a synthetic provider through the real authenticated HTTP/import flow and isolated PostgreSQL schemas, including four Pickings sharing one address, partial/failed source scans, provider failures, stale addresses, cache reuse, pacing and processing limits. The network boundary test confirms that the source snapshot and import lock are released before lookup.

Backend: strict typecheck, full typed lint, production build and **327/327 tests** passed. Backoffice: typecheck, typed lint, production builds and **225/225 tests** passed. A pending-import regression verifies that an already-open card, Nearby and the map refresh with unchanged delivery version while preserving DOM, tab, scroll and unsaved notes. The main, acceptance, restored and Odoo integration APIs all remained healthy after deployment. Live before/after evidence and import results are in the stand's ignored `.local` directory; do not commit credentials or source configuration.
