-- Migration: Rename GEX columns from QQQ/NQ-specific to generic ETF/futures names.
-- Run this ONCE after deploying the updated code.
-- Hibernate ddl-auto=update will create the new columns; this script copies data and drops the old ones.

-- 1. gamma_exposure: copy data to new columns
ALTER TABLE gamma_exposure ADD COLUMN IF NOT EXISTS etf_price DOUBLE PRECISION;
ALTER TABLE gamma_exposure ADD COLUMN IF NOT EXISTS futures_price DOUBLE PRECISION;

UPDATE gamma_exposure SET etf_price = qqq_price WHERE etf_price IS NULL;
UPDATE gamma_exposure SET futures_price = nq_price WHERE futures_price IS NULL;

ALTER TABLE gamma_exposure DROP COLUMN IF EXISTS qqq_price;
ALTER TABLE gamma_exposure DROP COLUMN IF EXISTS nq_price;

-- 2. gamma_levels: copy data to new columns
ALTER TABLE gamma_levels ADD COLUMN IF NOT EXISTS strike_etf DOUBLE PRECISION;
ALTER TABLE gamma_levels ADD COLUMN IF NOT EXISTS strike_futures DOUBLE PRECISION;

UPDATE gamma_levels SET strike_etf = strike_qqq WHERE strike_etf IS NULL;
UPDATE gamma_levels SET strike_futures = strike_nq WHERE strike_futures IS NULL;

ALTER TABLE gamma_levels DROP COLUMN IF EXISTS strike_qqq;
ALTER TABLE gamma_levels DROP COLUMN IF EXISTS strike_nq;
