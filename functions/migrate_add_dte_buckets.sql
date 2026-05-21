-- Split per-strike GEX into days-to-expiry buckets on gamma_levels.
-- Run once against your Supabase DB (SQL editor or psql).
-- Rows ingested before this migration will have NULL for these columns;
-- the ML pipeline filters them out when 0DTE-aware features are requested.

ALTER TABLE gamma_levels ADD COLUMN IF NOT EXISTS gex_0dte    DOUBLE PRECISION;
ALTER TABLE gamma_levels ADD COLUMN IF NOT EXISTS gex_1dte    DOUBLE PRECISION;
ALTER TABLE gamma_levels ADD COLUMN IF NOT EXISTS gex_weekly  DOUBLE PRECISION;
ALTER TABLE gamma_levels ADD COLUMN IF NOT EXISTS gex_monthly DOUBLE PRECISION;
