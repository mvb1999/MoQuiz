#!/usr/bin/env bash
# Spielt alle Migrationen in eine frische Testdatenbank ein und prüft die
# Datenbankfunktionen mit Supabase-ähnlichen Rollen (anon, authenticated).
#
# Lokal:  PGHOST=localhost PGPORT=5432 PGPASSWORD=… bash tests/sql/run.sh
# Benötigt: psql (PostgreSQL 15 oder neuer) und Python mit psycopg 3.
set -euo pipefail
cd "$(dirname "$0")"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
export MOQUIZ_TEST_DB="${MOQUIZ_TEST_DB:-moquiz_test}"
DB="$MOQUIZ_TEST_DB"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
"${PSQL[@]}" -d "$DB" -f stub.sql
for f in ../../supabase/migrations/*.sql; do
  echo "Migration: $(basename "$f")"
  PGPASSWORD=moquiz-test "${PSQL[@]}" -U owner -d "$DB" -f "$f"
done
python3 test.py
