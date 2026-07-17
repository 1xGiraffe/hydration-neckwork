-- Canonical schema for hydration-neckwork, generated from the live price_data DB
-- (ground truth). Applied in numeric order to an empty DB by schema-bootstrap,
-- before ingestion. All DDL is idempotent (CREATE ... IF NOT EXISTS). No migrations.
CREATE DATABASE IF NOT EXISTS price_data;
