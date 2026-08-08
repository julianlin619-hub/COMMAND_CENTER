-- Ad Carousels v2: persistent filtered bank + permutation ledger.
--
-- The feature changed shape from "one prompt-picked carousel per run"
-- to "one-off filtered bank, then batch permutation generation":
--
-- 1. ads_bank — the once-off topical bank. A build pass runs every
--    master-bank tweet (tweet_bank) through a Claude filter against the
--    saved brief (e.g. entrepreneurship/mindset) and stores the keepers
--    here. Text and favorite_count are denormalized from tweet_bank so
--    generation never joins or re-reads the 5K-row master bank.
--    Rebuilding the bank wipes and refills this table.
--
-- 2. ads_carousels — the permutation ledger. One row per carousel ever
--    generated, holding its 9 tweet_ids in slide order. Every new
--    permutation must differ from EVERY previous one by >= 3 tweets
--    (share <= 6 of 9); that check is set math in Python — this table
--    is the durable memory that makes "generate 100 now, 100 more next
--    week, no overlap" work across runs.

CREATE TABLE ads_bank (
    tweet_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    favorite_count INT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ads_carousels (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    -- Slide order as rendered (random per carousel). Dedup compares
    -- these as sets, so order changes never bypass the >=3-differ rule.
    tweet_ids TEXT[] NOT NULL,
    drive_folder_id TEXT,
    drive_folder_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Service-role-only access, like every other table (the anon key gets
-- nothing; all server code uses the service key which bypasses RLS —
-- the explicit policies document intent and satisfy the advisor).
ALTER TABLE ads_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_carousels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on ads_bank"
    ON ads_bank FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on ads_carousels"
    ON ads_carousels FOR ALL
    USING (auth.role() = 'service_role');
