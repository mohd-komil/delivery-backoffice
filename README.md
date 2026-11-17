# Delivery Backoffice

Delivery planning and on-site operations for furniture delivery and installation. The project contains three independently installable applications.

- [Backend setup, verification, and access rules](backoffice-backend/README.md) — NestJS, TypeORM, and PostgreSQL
- [Backoffice setup and interface](backoffice-frontend/README.md) — Next.js dispatch workspace
- [Crew setup and sign-in](crew-frontend/README.md) — Next.js mobile PWA for assigned visits and routes
- [Development plan in Notion](https://app.notion.com/p/40c4433fac0f815ab7e5fb9257f22047)
- [Verified implementation status](backoffice-backend/docs/STATUS.md)
- [Source model and expected SQL results](backoffice-backend/docs/source-model.md)
- [Vehicles and visit transport](backoffice-backend/docs/vehicles.md)
- [Product-line work quantities and two-visit demo](backoffice-backend/docs/required-work.md)
- [Customer signature refusal and dispatcher review](backoffice-backend/docs/signature-refusal.md)
- [Backup and recovery](backoffice-backend/docs/recovery.md)

## Local environment

The [Docker Compose runbook](backoffice-backend/docs/docker.md) covers PostgreSQL, the API, migrations, and the import and test commands. Named volumes store the application data and private files. The original native PostgreSQL cluster was retained for rollback when the existing development data moved into Docker. Run each frontend from its own directory on the host.

| Environment | Backoffice | API | Crew |
| --- | --- | --- | --- |
| Local synthetic-data stack | [3000](http://127.0.0.1:3000) | [3001](http://127.0.0.1:3001/api) | [3002](http://127.0.0.1:3002) |
| Odoo customer-development copy | [3030](http://127.0.0.1:3030) | [3031](http://127.0.0.1:3031/api) | [3032](http://127.0.0.1:3032) |

The synthetic stack's Docker PostgreSQL endpoint for SQL clients is `127.0.0.1:55433`. Keep `.env` and `.local` files private. The local setup generates demonstration credentials in `backoffice-backend/.local/demo-accounts.json` and `backoffice-backend/.local/participant-demo-accounts.json`. The [Odoo integration runbook](backoffice-backend/docs/odoo-integration.md) covers the separate, read-only development copy.
