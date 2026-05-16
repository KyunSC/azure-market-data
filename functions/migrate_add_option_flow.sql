-- Add option-flow feature columns to gamma_exposure.
-- Run once against your Supabase DB (SQL editor or psql).
-- Rows ingested before this migration will have NULL for these columns.
-- The ML pipeline will begin using them once enough post-migration snapshots accumulate.

ALTER TABLE gamma_exposure ADD COLUMN IF NOT EXISTS pcr_volume FLOAT;
ALTER TABLE gamma_exposure ADD COLUMN IF NOT EXISTS pcr_oi     FLOAT;
ALTER TABLE gamma_exposure ADD COLUMN IF NOT EXISTS iv_atm     FLOAT;
ALTER TABLE gamma_exposure ADD COLUMN IF NOT EXISTS iv_skew    FLOAT;
