-- Extend the existing isolated testnet journal to the exact public Bouncer
-- Vercel origin. Existing rows, claims and original hashes are retained; no
-- state is reset. This migration cannot sign or send a NEAR transaction.
BEGIN;
ALTER TABLE bouncer_direct_test.claims DROP CONSTRAINT claims_origin_check;
ALTER TABLE bouncer_direct_test.claims ADD CONSTRAINT claims_origin_check CHECK (
  origin ~ '^https://[a-z0-9]{4,20}\.csb\.app$' OR origin = 'https://bouncer-near.vercel.app'
);
CREATE OR REPLACE FUNCTION public.bouncer_direct_test_v1(p_capability_hash text, p_origin text, p_operation text, p_original_hash text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  item bouncer_direct_test.claims%ROWTYPE;
  won boolean := false;
BEGIN
  IF p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$'
     OR p_origin IS NULL OR (p_origin !~ '^https://[a-z0-9]{4,20}\.csb\.app$' AND p_origin <> 'https://bouncer-near.vercel.app')
     OR p_operation IS NULL OR p_operation NOT IN ('read', 'claim', 'retain')
     OR (p_operation <> 'retain' AND p_original_hash IS NOT NULL)
     OR (p_operation = 'retain' AND (p_original_hash IS NULL OR p_original_hash !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'))
  THEN RETURN jsonb_build_object('error', 'unavailable'); END IF;
  SELECT * INTO item FROM bouncer_direct_test.claims
    WHERE capability_hash = p_capability_hash AND origin = p_origin FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'unavailable'); END IF;
  IF p_operation = 'claim' AND item.state = 'ready' AND item.expires_at > clock_timestamp() THEN
    UPDATE bouncer_direct_test.claims SET state = 'claimed', claimed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE capability_hash = p_capability_hash RETURNING * INTO item;
    won := true;
  ELSIF p_operation = 'retain' THEN
    IF item.state = 'ready' OR (item.original_hash IS NOT NULL AND item.original_hash <> p_original_hash)
    THEN RETURN jsonb_build_object('error', 'unavailable'); END IF;
    UPDATE bouncer_direct_test.claims SET state = 'retained', original_hash = p_original_hash, updated_at = clock_timestamp()
      WHERE capability_hash = p_capability_hash RETURNING * INTO item;
  END IF;
  RETURN jsonb_build_object('scope', item.scope, 'state', item.state, 'original_hash', item.original_hash,
    'claim_acquired', won, 'expired', item.expires_at <= clock_timestamp());
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_direct_test_v1(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bouncer_direct_test_v1(text, text, text, text) TO service_role;
COMMIT;
