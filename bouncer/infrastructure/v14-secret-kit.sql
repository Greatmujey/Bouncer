-- Experimental encrypted V14 key-kit retention, NOT a journal backup. The
-- owner-authenticated Edge caller must verify the exact NEP-413 signature;
-- PostgreSQL cannot verify the wallet signature itself. No reset, overwrite,
-- vault action, signing or spend is added. Never enable the caller until its
-- exact deployed source, secure handoff and recovery flow have been reviewed.
BEGIN;
CREATE TABLE bouncer_v14_originals_v1.secret_kits (
  scope_id text PRIMARY KEY REFERENCES bouncer_v14_originals_v1.streams(scope_id),
  kit_sha256 text NOT NULL CHECK (kit_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_kit text NOT NULL CHECK (octet_length(sealed_kit) BETWEEN 32 AND 16000),
  attestation_sha256 text NOT NULL CHECK (attestation_sha256 ~ '^[0-9a-f]{64}$'),
  owner_attestation text NOT NULL CHECK (octet_length(owner_attestation) BETWEEN 32 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE bouncer_v14_originals_v1.secret_kits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bouncer_v14_originals_v1.secret_kits FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER no_secret_kit_changes BEFORE UPDATE OR DELETE ON bouncer_v14_originals_v1.secret_kits
FOR EACH ROW EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();
CREATE TRIGGER no_secret_kit_truncate BEFORE TRUNCATE ON bouncer_v14_originals_v1.secret_kits
FOR EACH STATEMENT EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();

-- Create a new stream and retain one encrypted key kit atomically. Exact
-- replay only returns the original; another kit, scope or capability cannot
-- replace it. An existing v1 stream without a kit cannot be retrofitted, even
-- at revision zero: an empty history does not prove no prompt occurred. A lost
-- acknowledgement is uncertain, not permission to generate a different scope
-- or open a wallet prompt again.
CREATE FUNCTION public.bouncer_v14_enroll_kit_v2(
  p_scope_id text,p_capability_hash text,p_owner_id text,p_vault_id text,p_owner_public_key text,p_review_sha256 text,
  p_kit_sha256 text,p_sealed_kit text,p_attestation_sha256 text,p_owner_attestation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_originals_v1.streams%ROWTYPE; saved bouncer_v14_originals_v1.secret_kits%ROWTYPE;
  document jsonb; attestation jsonb; created boolean:=false;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~ '^[0-9a-f]{32}$' OR
     p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' OR
     p_owner_id IS NULL OR p_vault_id IS NULL OR
     p_owner_public_key IS NULL OR p_owner_public_key !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$' OR
     p_review_sha256 IS NULL OR p_review_sha256 !~ '^[0-9a-f]{64}$' OR
     p_kit_sha256 IS NULL OR p_kit_sha256 !~ '^[0-9a-f]{64}$' OR
     p_sealed_kit IS NULL OR octet_length(p_sealed_kit)<32 OR octet_length(p_sealed_kit)>16000 OR
     position(E'\n' IN p_sealed_kit)<>0 OR position(E'\r' IN p_sealed_kit)<>0 OR
     encode(sha256(convert_to(p_sealed_kit,'UTF8')),'hex')<>p_kit_sha256 OR
     p_attestation_sha256 IS NULL OR p_attestation_sha256 !~ '^[0-9a-f]{64}$' OR
     p_owner_attestation IS NULL OR octet_length(p_owner_attestation)<32 OR octet_length(p_owner_attestation)>4096 OR
     position(E'\n' IN p_owner_attestation)<>0 OR position(E'\r' IN p_owner_attestation)<>0 OR
     encode(sha256(convert_to(p_owner_attestation,'UTF8')),'hex')<>p_attestation_sha256 THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  BEGIN document:=p_sealed_kit::jsonb; attestation:=p_owner_attestation::jsonb;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error','unavailable'); END;
  IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR jsonb_typeof(attestation) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(attestation))<>3 OR
     jsonb_typeof(attestation->'terms') IS DISTINCT FROM 'object' OR
     attestation->'terms'->>'format' IS DISTINCT FROM 'bouncer-v14-checkpoint-kit-enrollment-v2' OR
     attestation->'terms'->>'scope_id' IS DISTINCT FROM p_scope_id OR
     attestation->'terms'->>'owner' IS DISTINCT FROM p_owner_id OR attestation->'terms'->>'vault' IS DISTINCT FROM p_vault_id OR
     attestation->'terms'->>'owner_public_key' IS DISTINCT FROM p_owner_public_key OR
     attestation->'terms'->>'review_sha256' IS DISTINCT FROM p_review_sha256 OR
     attestation->'terms'->>'capability_sha256' IS DISTINCT FROM p_capability_hash OR
     attestation->'terms'->>'kit_sha256' IS DISTINCT FROM p_kit_sha256 OR
     jsonb_typeof(attestation->'nonce_base64') IS DISTINCT FROM 'string' OR
     jsonb_typeof(attestation->'signature_base64') IS DISTINCT FROM 'string' THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(document))<>12 OR
     document->>'format' IS DISTINCT FROM 'bouncer-v14-secret-kit-v1' OR
     document->>'kdf' IS DISTINCT FROM 'PBKDF2-SHA256' OR document->'iterations' IS DISTINCT FROM to_jsonb(600000) OR
     document->>'cipher' IS DISTINCT FROM 'AES-256-GCM' OR
     document->>'owner' IS DISTINCT FROM p_owner_id OR document->>'vault' IS DISTINCT FROM p_vault_id OR
     document->>'scope_id' IS DISTINCT FROM p_scope_id OR document->>'review_sha256' IS DISTINCT FROM p_review_sha256 OR
     document->>'capability_sha256' IS DISTINCT FROM p_capability_hash OR
     jsonb_typeof(document->'salt_base64') IS DISTINCT FROM 'string' OR
     jsonb_typeof(document->'iv_base64') IS DISTINCT FROM 'string' OR
     jsonb_typeof(document->'ciphertext_base64') IS DISTINCT FROM 'string' OR
     document->>'salt_base64' !~ '^[A-Za-z0-9+/]{22}==$' OR
     document->>'iv_base64' !~ '^[A-Za-z0-9+/]{16}$' OR
     document->>'ciphertext_base64' !~ '^[A-Za-z0-9+/]+={0,2}$' OR
     length(document->>'ciphertext_base64') NOT BETWEEN 24 AND 16000 THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  INSERT INTO bouncer_v14_originals_v1.streams(scope_id,capability_hash,owner_id,vault_id,owner_public_key,review_sha256)
    VALUES(p_scope_id,p_capability_hash,p_owner_id,p_vault_id,p_owner_public_key,p_review_sha256)
    ON CONFLICT DO NOTHING RETURNING * INTO item;
  IF FOUND THEN created:=true;
  ELSE
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams
      WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash AND owner_id=p_owner_id AND vault_id=p_vault_id
        AND owner_public_key=p_owner_public_key AND review_sha256=p_review_sha256 FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  END IF;
  SELECT * INTO saved FROM bouncer_v14_originals_v1.secret_kits WHERE scope_id=p_scope_id;
  IF NOT FOUND THEN
    IF NOT created OR item.revision<>0 OR item.head_sha256<>repeat('0',64) THEN RETURN jsonb_build_object('error','unavailable'); END IF;
    INSERT INTO bouncer_v14_originals_v1.secret_kits(scope_id,kit_sha256,sealed_kit,attestation_sha256,owner_attestation)
      VALUES(p_scope_id,p_kit_sha256,p_sealed_kit,p_attestation_sha256,p_owner_attestation) RETURNING * INTO saved;
  END IF;
  IF saved.kit_sha256<>p_kit_sha256 OR saved.sealed_kit<>p_sealed_kit OR
     saved.attestation_sha256<>p_attestation_sha256 OR saved.owner_attestation<>p_owner_attestation THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  RETURN jsonb_build_object('status',CASE WHEN created THEN 'ENROLLED_WITH_KIT' ELSE 'EXISTING_KIT' END,
    'scope_id',item.scope_id,'revision',item.revision,'head_sha256',item.head_sha256,
    'kit_sha256',saved.kit_sha256,'attestation_sha256',saved.attestation_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_v14_enroll_kit_v2(text,text,text,text,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_enroll_kit_v2(text,text,text,text,text,text,text,text,text,text) TO service_role;

-- This returns ciphertext and public hashes only. The Edge caller must verify a
-- current owner's explicit read request first. It never returns a passphrase,
-- capability, journal plaintext or wallet key, and cannot alter a stream.
CREATE FUNCTION public.bouncer_v14_owner_kit_inspect_v2(p_owner_id text,p_vault_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_originals_v1.streams%ROWTYPE; saved bouncer_v14_originals_v1.secret_kits%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_vault_id IS NULL THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT * INTO item FROM bouncer_v14_originals_v1.streams
    WHERE owner_id=p_owner_id AND vault_id=p_vault_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT * INTO saved FROM bouncer_v14_originals_v1.secret_kits WHERE scope_id=item.scope_id;
  IF NOT FOUND OR encode(sha256(convert_to(saved.sealed_kit,'UTF8')),'hex')<>saved.kit_sha256 OR
      encode(sha256(convert_to(saved.owner_attestation,'UTF8')),'hex')<>saved.attestation_sha256 THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  RETURN jsonb_build_object('status','EXISTING_ENCRYPTED_KIT','scope_id',item.scope_id,
    'review_sha256',item.review_sha256,'capability_sha256',item.capability_hash,
    'kit_sha256',saved.kit_sha256,'sealed_kit',saved.sealed_kit,
    'attestation_sha256',saved.attestation_sha256,'owner_attestation',saved.owner_attestation);
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_v14_owner_kit_inspect_v2(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_owner_kit_inspect_v2(text,text) TO service_role;
COMMIT;
