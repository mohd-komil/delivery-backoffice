-- Shared native/Docker bootstrap. Creates only missing roles and empty databases;
-- existing passwords and business rows are never replaced.
\set ON_ERROR_STOP on
\getenv app_password BACKOFFICE_LOCAL_APP_PASSWORD
\getenv owner_password BACKOFFICE_LOCAL_SOURCE_OWNER_PASSWORD
\getenv reader_password BACKOFFICE_LOCAL_READER_PASSWORD
SELECT format('CREATE ROLE delivery_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='delivery_app') \gexec
SELECT format('CREATE ROLE odoo_seed LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'owner_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='odoo_seed') \gexec
SELECT format('CREATE ROLE odoo_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'reader_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='odoo_reader') \gexec
SELECT 'CREATE DATABASE odoo_mock OWNER odoo_seed TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C''' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='odoo_mock') \gexec
SELECT 'CREATE DATABASE delivery_backoffice OWNER delivery_app TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C''' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='delivery_backoffice') \gexec
SELECT 'CREATE DATABASE delivery_backoffice_test OWNER delivery_app TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C''' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='delivery_backoffice_test') \gexec
REVOKE ALL ON DATABASE odoo_mock FROM PUBLIC;
REVOKE ALL ON DATABASE delivery_backoffice FROM PUBLIC;
REVOKE ALL ON DATABASE delivery_backoffice_test FROM PUBLIC;
GRANT CONNECT ON DATABASE odoo_mock TO odoo_reader;
GRANT CONNECT ON DATABASE delivery_backoffice, delivery_backoffice_test TO delivery_app;
ALTER ROLE odoo_reader IN DATABASE odoo_mock SET default_transaction_read_only = on;
\connect odoo_mock
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO odoo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO odoo_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE odoo_seed IN SCHEMA public GRANT SELECT ON TABLES TO odoo_reader;
