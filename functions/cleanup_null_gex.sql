-- Cleanup for the broken QQQ/NQ GEX rows where strike_futures and strike_etf
-- are NULL. These accumulated when a fallback chain (fallback_gex_from_previous)
-- copied a previous fallback row that itself had nulls, propagating bad data
-- forward each ingestion cycle.
--
-- Run once against Supabase. Safe to re-run; null rows are deleted, valid rows
-- are untouched.

-- 1) If the legacy QQQ/NQ-named columns still exist, backfill the new
--    strike_etf / strike_futures columns from them so we don't throw away
--    data that's actually recoverable.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gamma_exposure' AND column_name = 'qqq_price'
    ) THEN
        UPDATE gamma_exposure SET etf_price = qqq_price WHERE etf_price IS NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gamma_exposure' AND column_name = 'nq_price'
    ) THEN
        UPDATE gamma_exposure SET futures_price = nq_price WHERE futures_price IS NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gamma_levels' AND column_name = 'strike_qqq'
    ) THEN
        UPDATE gamma_levels SET strike_etf = strike_qqq WHERE strike_etf IS NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gamma_levels' AND column_name = 'strike_nq'
    ) THEN
        UPDATE gamma_levels SET strike_futures = strike_nq WHERE strike_futures IS NULL;
    END IF;
END $$;

-- 2) Drop levels that still have no strike data — they're unrecoverable.
DELETE FROM gamma_levels
WHERE strike_etf IS NULL OR strike_futures IS NULL;

-- 3) Drop gamma_exposure rows that lost prices or have no levels left.
--    The next scheduled ingestion will write a fresh, valid row.
DELETE FROM gamma_exposure
WHERE etf_price IS NULL
   OR futures_price IS NULL
   OR id NOT IN (SELECT DISTINCT gamma_exposure_id FROM gamma_levels);
