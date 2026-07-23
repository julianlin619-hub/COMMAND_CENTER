-- Add a likes filter to the match_tweet_bank RPC.
--
-- The Instagram carousel pipeline (cron/instagram_carousel_pipeline.py)
-- reuses the tweet-bank RAG lookup to find tweets *thematically similar*
-- to an anchor tweet, but only wants proven performers (>= 4000 likes).
-- Filtering must happen SQL-side, not in Python: only ~16% of bank rows
-- clear 4000 likes, so a Python post-filter would need to over-fetch
-- 5-6x the candidates to reliably survive, while a WHERE clause keeps
-- top-k exact among qualifying rows. At ~5K rows the filtered scan cost
-- is negligible.
--
-- IMPORTANT: CREATE OR REPLACE with a *new parameter list* would create a
-- second overload, not replace the function — and then
-- client.rpc("match_tweet_bank", ...) calls become ambiguous and fail.
-- So we DROP the old 2-arg signature first.
--
-- min_favorite_count defaults to 0, so the existing caller
-- (core/caption_rag.py, which passes only query_embedding + match_count)
-- keeps its exact current behaviour with no code change.
--
-- Note on HNSW + WHERE: pgvector applies the filter while walking the
-- graph index, which can theoretically return fewer than match_count
-- rows under heavy filtering. With ~780 qualifying rows and
-- match_count <= 15 this is a non-issue.
DROP FUNCTION IF EXISTS match_tweet_bank(vector, int);

-- Same body and security posture as the original in
-- 20260606120000_video_batch.sql: SET search_path = '' pins name
-- resolution (so everything is schema-qualified, including the cosine
-- operator as OPERATOR(public.<=>)), and EXECUTE is revoked from the
-- browser-reachable roles — only the service key ever calls this.
CREATE OR REPLACE FUNCTION match_tweet_bank(
    query_embedding vector(1536),
    match_count int DEFAULT 10,
    min_favorite_count int DEFAULT 0
)
RETURNS TABLE (
    tweet_id text,
    text text,
    favorite_count int,
    similarity float
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
    SELECT
        tb.tweet_id,
        tb.text,
        tb.favorite_count,
        1 - (tb.embedding OPERATOR(public.<=>) query_embedding) AS similarity
    FROM public.tweet_bank tb
    WHERE tb.embedding IS NOT NULL
      -- COALESCE: favorite_count is nullable; treat NULL as 0 likes so a
      -- likes floor > 0 excludes rows with unknown engagement.
      AND COALESCE(tb.favorite_count, 0) >= min_favorite_count
    ORDER BY tb.embedding OPERATOR(public.<=>) query_embedding
    LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION match_tweet_bank(vector, int, int) FROM PUBLIC, anon, authenticated;
