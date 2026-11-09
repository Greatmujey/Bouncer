-- Adds owner-signed enrollment metadata to the already-created V14 original
-- checkpoint. The service role may call enrollment only through the separately
-- reviewed Edge verifier; that verifier checks the exact NEP-413 message and
-- a current testnet FullAccess key. The database cannot verify that signature
-- itself, so a compromised service-role key remains a trust boundary. No reset,
-- deletion, signing, wallet transaction, payment or vault deployment is added.
BEGIN;
ALTER TABLE bouncer_v14_originals_v1.streams
  ADD COLUMN owner_public_key text NOT NULL CHECK (owner_public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ADD COLUMN review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION bouncer_v14_originals_v1.guard_stream_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.scope_id<>OLD.scope_id OR NEW.owner_id<>OLD.owner_id OR NEW.vault_id<>OLD.vault_id OR
     NEW.owner_public_key<>OLD.owner_public_key OR NEW.review_sha256<>OLD.review_sha256 OR
     NEW.capability_hash<>OLD.capability_hash OR NEW.created_at<>OLD.created_at OR
     NEW.revision<>OLD.revision+1 OR NEW.head_sha256=OLD.head_sha256 THEN
    RAISE EXCEPTION 'original stream cannot be reset or rewritten';
  END IF;
  RETURN NEW;
END;
$$;

-- A first reservation must be the exact review and owner public key covered by
-- the off-chain enrollment. The application additionally validates every byte
-- of the public review, action commitments and subsequent event history.
CREATE FUNCTION bouncer_v14_originals_v1.guard_initial_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_originals_v1.streams%ROWTYPE; document jsonb;
BEGIN
  IF NEW.seq=1 THEN
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams WHERE scope_id=NEW.scope_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'checkpoint stream unavailable'; END IF;
    BEGIN document:=NEW.record::jsonb; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid initial review'; END;
    IF document->'data'->>'review_sha256' IS DISTINCT FROM item.review_sha256 OR
       document->'data'->'public_review'->>'review_sha256' IS DISTINCT FROM item.review_sha256 OR
       document->'data'->'public_review'->>'owner_public_key' IS DISTINCT FROM item.owner_public_key THEN
      RAISE EXCEPTION 'initial review differs from owner enrollment';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_initial_review BEFORE INSERT ON bouncer_v14_originals_v1.events
FOR EACH ROW EXECUTE FUNCTION bouncer_v14_originals_v1.guard_initial_review();

CREATE FUNCTION public.bouncer_v14_enroll_v1(
  p_scope_id text,p_capability_hash text,p_owner_id text,p_vault_id text,p_owner_public_key text,p_review_sha256 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_originals_v1.streams%ROWTYPE; created boolean:=false;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~ '^[0-9a-f]{32}$' OR
     p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' OR
     p_owner_id IS NULL OR p_vault_id IS NULL OR
     p_owner_public_key IS NULL OR p_owner_public_key !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$' OR
     p_review_sha256 IS NULL OR p_review_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  INSERT INTO bouncer_v14_originals_v1.streams(scope_id,capability_hash,owner_id,vault_id,owner_public_key,review_sha256)
    VALUES(p_scope_id,p_capability_hash,p_owner_id,p_vault_id,p_owner_public_key,p_review_sha256)
    ON CONFLICT DO NOTHING RETURNING * INTO item;
  IF FOUND THEN created:=true;
  ELSE
    -- Replaying the same off-chain signature can reveal only the same stream;
    -- it cannot reset it, change its capability, or authorize a transaction.
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams
      WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash AND owner_id=p_owner_id AND vault_id=p_vault_id
        AND owner_public_key=p_owner_public_key AND review_sha256=p_review_sha256;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  END IF;
  RETURN jsonb_build_object('status',CASE WHEN created THEN 'ENROLLED' ELSE 'ALREADY_ENROLLED' END,
    'scope_id',item.scope_id,'revision',item.revision,'head_sha256',item.head_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_v14_enroll_v1(text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_enroll_v1(text,text,text,text,text,text) TO service_role;

-- Read-only owner recovery does not need the checkpoint capability. The Edge
-- caller must first verify a current owner FullAccess signature. Returning an
-- empty history never proves no transaction exists, and this does not rotate a
-- capability or create, delete, rewrite or reset a stream.
CREATE FUNCTION public.bouncer_v14_owner_inspect_v1(p_owner_id text,p_vault_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_originals_v1.streams%ROWTYPE; records jsonb;
BEGIN
  IF p_owner_id IS NULL OR p_vault_id IS NULL THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT * INTO item FROM bouncer_v14_originals_v1.streams
    WHERE owner_id=p_owner_id AND vault_id=p_vault_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT COALESCE(jsonb_agg(record ORDER BY seq),'[]'::jsonb) INTO records
    FROM bouncer_v14_originals_v1.events WHERE scope_id=item.scope_id;
  RETURN jsonb_build_object('status','EXISTING_CHECKPOINT','scope_id',item.scope_id,
    'revision',item.revision,'head_sha256',item.head_sha256,'events',records);
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_v14_owner_inspect_v1(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_owner_inspect_v1(text,text) TO service_role;
COMMIT;
