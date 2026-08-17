#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_MIGRATION_URL:?DATABASE_MIGRATION_URL is required}"

docker run --rm --network host postgres:17-alpine \
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'companion_api') THEN
       CREATE ROLE companion_api LOGIN PASSWORD 'companion-api'
         NOSUPERUSER NOBYPASSRLS NOINHERIT;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'companion_worker') THEN
       CREATE ROLE companion_worker LOGIN PASSWORD 'companion-worker'
         NOSUPERUSER NOBYPASSRLS NOINHERIT;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'companion_runtime_v2') THEN
       CREATE ROLE companion_runtime_v2 LOGIN PASSWORD 'companion-runtime-v2'
         NOSUPERUSER NOBYPASSRLS NOINHERIT;
     END IF;
   END \$\$;
   ALTER ROLE companion_api NOSUPERUSER NOBYPASSRLS NOINHERIT;
   ALTER ROLE companion_worker NOSUPERUSER NOBYPASSRLS NOINHERIT;
   ALTER ROLE companion_runtime_v2 NOSUPERUSER NOBYPASSRLS NOINHERIT;"
