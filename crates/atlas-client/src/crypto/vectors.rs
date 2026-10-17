//! The shared crypto vectors in `test-vectors/`, asserted against this crate. The TypeScript client
//! asserts the same files, so both stay byte-compatible.

use serde_json::{json, Value};

use super::*;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../test-vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture")).expect("JSON")
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

fn h32(v: &Value, key: &str) -> [u8; 32] {
    from_hex32(s(v, key)).unwrap()
}

fn payload(v: &Value) -> EncryptedPayload {
    serde_json::from_value(v.clone()).unwrap()
}

fn iv_of(p: &Value) -> [u8; 12] {
    from_base64(p["iv"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}

#[test]
fn argon2id_reproduces_the_reference_vectors() {
    let f = fixture("password_kdf_vectors.json");
    for v in f["argon2id"].as_array().unwrap() {
        let out = argon2id(
            s(v, "password").as_bytes(),
            s(v, "salt").as_bytes(),
            v["memory_kib"].as_u64().unwrap() as u32,
            v["iterations"].as_u64().unwrap() as u32,
            v["parallelism"].as_u64().unwrap() as u32,
            32,
        )
        .unwrap();
        assert_eq!(hex::encode(out), s(v, "hash"), "{}", s(v, "name"));
    }
    // RFC 9106 5.3 also takes a secret and associated data.
    let r = &f["rfc9106_argon2id"];
    let ad = from_hex(s(r, "associated_data_hex")).unwrap();
    let params = argon2::ParamsBuilder::new()
        .m_cost(r["memory_kib"].as_u64().unwrap() as u32)
        .t_cost(r["iterations"].as_u64().unwrap() as u32)
        .p_cost(r["parallelism"].as_u64().unwrap() as u32)
        .data(argon2::AssociatedData::new(&ad).unwrap())
        .output_len(32)
        .build()
        .unwrap();
    let secret = from_hex(s(r, "secret_hex")).unwrap();
    let argon = argon2::Argon2::new_with_secret(
        &secret,
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        params,
    )
    .unwrap();
    let mut out = [0u8; 32];
    argon
        .hash_password_into(
            &from_hex(s(r, "password_hex")).unwrap(),
            &from_hex(s(r, "salt_hex")).unwrap(),
            &mut out,
        )
        .unwrap();
    assert_eq!(hex::encode(out), s(r, "hash"));
}

#[test]
fn the_login_derivations_match() {
    let f = fixture("password_kdf_vectors.json");
    for v in f["derivations"].as_array().unwrap() {
        let kdf = kdf_from_wire(&v["kdf_version"], &v["kdf_params"])
            .unwrap()
            .unwrap();
        let master = master_key(s(v, "password"), s(v, "salt"), kdf).unwrap();
        assert_eq!(hex::encode(master), s(v, "master_key"), "{}", s(v, "name"));
        let keys = expand_master_key(&master);
        assert_eq!(keys.auth_hash, s(v, "auth_hash"));
        assert_eq!(hex::encode(keys.mek), s(v, "mek"));
    }
}

#[test]
fn kdf_parameters_outside_the_bounds_are_refused() {
    assert_eq!(kdf_from_wire(&Value::Null, &Value::Null).unwrap(), None);
    assert_eq!(
        kdf_from_wire(
            &json!(2),
            &json!({"iterations": 3, "memory_kib": 65536, "parallelism": 1})
        )
        .unwrap(),
        Some(CURRENT_KDF)
    );
    for (version, params) in [
        (
            json!(2),
            json!({"iterations": 2, "memory_kib": 65536, "parallelism": 1}),
        ),
        (
            json!(2),
            json!({"iterations": 3, "memory_kib": 1024, "parallelism": 1}),
        ),
        (json!(2), json!({"iterations": 3, "memory_kib": 65536})),
        (json!(1), json!({"iterations": 1000})),
        (json!(3), json!({})),
        (Value::Null, json!({"iterations": 1})),
    ] {
        assert!(
            kdf_from_wire(&version, &params).is_err(),
            "{version} {params}"
        );
    }
}

#[test]
fn api_token_vectors() {
    for v in fixture("api_token_vectors.json")["vectors"]
        .as_array()
        .unwrap()
    {
        let parts = parse_api_token(s(v, "token")).unwrap();
        assert_eq!(parts.id, s(v, "id"));
        assert_eq!(hex::encode(parts.secret), s(v, "secret"));
        assert_eq!(format_api_token(&parts), s(v, "token"));
        let keys = derive_api_token_keys(&parts);
        assert_eq!(keys.auth, s(v, "auth"));
        assert_eq!(hex::encode(keys.wrap_key), s(v, "wrap_key"));
        let wd: ApiTokenWrap = serde_json::from_value(v["wrapped_dek"].clone()).unwrap();
        let wp: ApiTokenWrap = serde_json::from_value(v["wrapped_private_key"].clone()).unwrap();
        let (dek, private_key) = unwrap_api_token_keys(&parts, s(v, "user_id"), &wd, &wp).unwrap();
        assert_eq!(hex::encode(dek), s(v, "dek"));
        assert_eq!(hex::encode(private_key), s(v, "private_key"));
        // The wraps are bound: another account or slot does not open.
        assert!(
            unwrap_api_token_keys(&parts, "01920000-0000-7000-8000-000000000002", &wd, &wp)
                .is_err()
        );
        assert!(unwrap_api_token_keys(&parts, s(v, "user_id"), &wp, &wd).is_err());

        // Every other app's key and identity, as `app_keys` carries them.
        for (app, entry) in v["app_keys"].as_object().into_iter().flatten() {
            let wraps: ApiTokenAppWraps = serde_json::from_value(json!({
                "wrapped_key": entry["wrapped_key"],
                "wrapped_private_key": entry["wrapped_private_key"],
            }))
            .unwrap();
            let (app_key, app_private) =
                unwrap_api_token_app_keys(&parts, s(v, "user_id"), app, &wraps).unwrap();
            assert_eq!(hex::encode(app_key), s(entry, "app_key"), "{app}");
            assert_eq!(
                hex::encode(app_private),
                s(entry, "app_private_key"),
                "{app}"
            );
            // Bound to the account, the app and the slot.
            let other_user = "01920000-0000-7000-8000-000000000002";
            assert!(unwrap_api_token_app_keys(&parts, other_user, app, &wraps).is_err());
            assert!(unwrap_api_token_app_keys(&parts, s(v, "user_id"), "notes", &wraps).is_err());
            assert!(unwrap_api_token_app_keys(&parts, s(v, "user_id"), "todo", &wraps).is_err());
            let swapped = ApiTokenAppWraps {
                wrapped_key: wraps.wrapped_private_key.clone(),
                wrapped_private_key: wraps.wrapped_key.clone(),
            };
            assert!(unwrap_api_token_app_keys(&parts, s(v, "user_id"), app, &swapped).is_err());
            // Nor does the todo slot open an app wrap, or the reverse.
            assert!(unwrap_api_token_keys(
                &parts,
                s(v, "user_id"),
                &wraps.wrapped_key,
                &wraps.wrapped_private_key
            )
            .is_err());
            let wd_as_app = ApiTokenAppWraps {
                wrapped_key: wd.clone(),
                wrapped_private_key: wp.clone(),
            };
            assert!(unwrap_api_token_app_keys(&parts, s(v, "user_id"), app, &wd_as_app).is_err());
            // A fresh wrap round-trips.
            let fresh =
                wrap_app_keys_for_api_token(&parts, s(v, "user_id"), app, &app_key, &app_private)
                    .unwrap();
            assert_eq!(
                unwrap_api_token_app_keys(&parts, s(v, "user_id"), app, &fresh).unwrap(),
                (app_key, app_private)
            );
        }
        assert!(
            v["app_keys"]["journal"].is_object(),
            "the vectors cover journal"
        );
    }
    let parts = generate_api_token();
    for bad in ["todo", "", "Journal", "1x", "a-b"] {
        assert!(
            wrap_app_keys_for_api_token(&parts, "u", bad, &[1; 32], &[2; 32]).is_err(),
            "{bad}"
        );
    }
    for bad in [
        "",
        "atlas_pat_",
        "atlas_pat_AAAA",
        "pat_C19LfiwaTT6fYHqLnA0eLwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f",
        "atlas_pat_C19L*iwaTT6fYHqLnA0eLwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f",
    ] {
        assert!(parse_api_token(bad).is_err(), "{bad}");
    }
    let fresh = generate_api_token();
    let token = format_api_token(&fresh);
    assert_eq!(parse_api_token(&format!("  {token}\n")).unwrap(), fresh);
    assert_eq!(&fresh.id[14..15], "4");
}

#[test]
fn root_key_vectors() {
    for v in fixture("root_key_vectors.json")["vectors"]
        .as_array()
        .unwrap()
    {
        let user = s(v, "user_id");
        let root = h32(v, "root_key");
        let wrap = |key: &str| -> RootKeyWrap { serde_json::from_value(v[key].clone()).unwrap() };
        assert_eq!(
            unwrap_root_key(&wrap("password_slot"), &h32(v, "mek"), user, "password").unwrap(),
            root
        );
        assert_eq!(
            unwrap_root_key(
                &wrap("recovery_slot"),
                &h32(v, "recovery_wrap_key"),
                user,
                "recovery"
            )
            .unwrap(),
            root
        );
        let passkey = format!("passkey:{}", s(v, "passkey_credential"));
        assert_eq!(
            unwrap_root_key(
                &wrap("passkey_slot"),
                &h32(v, "passkey_wrap_key"),
                user,
                &passkey
            )
            .unwrap(),
            root
        );
        assert_eq!(
            x25519_public_key(&h32(v, "recovery_secret_key")),
            s(v, "recovery_public_key")
        );
        assert_eq!(
            unseal_root_key(
                &wrap("sealed_recovery_slot"),
                &h32(v, "recovery_secret_key"),
                user
            )
            .unwrap(),
            root
        );
        for slot in ["recovery_slot", "sealed_recovery_slot"] {
            assert_eq!(
                open_recovery_slot(
                    &wrap(slot),
                    &h32(v, "recovery_wrap_key"),
                    &h32(v, "recovery_secret_key"),
                    user
                )
                .unwrap(),
                root
            );
        }
        let dek = h32(v, "dek");
        assert_eq!(
            unwrap_app_key(&wrap("todo_app_key"), &root, user, "todo").unwrap(),
            dek
        );
        assert_eq!(
            unwrap_app_private_key(&wrap("todo_private_key"), &dek, user, "todo").unwrap(),
            h32(v, "private_key")
        );
        assert_eq!(
            unwrap_app_key(&wrap("notes_app_key"), &root, user, "notes").unwrap(),
            h32(v, "notes_key")
        );
        // Bound to the account, the slot and the app.
        assert!(unwrap_root_key(&wrap("password_slot"), &h32(v, "mek"), user, "recovery").is_err());
        assert!(unwrap_root_key(
            &wrap("password_slot"),
            &h32(v, "mek"),
            "01920000-0000-4000-8000-0000000000bb",
            "password"
        )
        .is_err());
        assert!(unwrap_app_key(&wrap("notes_app_key"), &root, user, "todo").is_err());
        // Fresh wraps round-trip.
        let w = wrap_root_key(&root, &h32(v, "mek"), user, "password").unwrap();
        assert_eq!(
            unwrap_root_key(&w, &h32(v, "mek"), user, "password").unwrap(),
            root
        );
        let sealed = seal_root_key(&root, s(v, "recovery_public_key"), user).unwrap();
        assert_eq!(
            unseal_root_key(&sealed, &h32(v, "recovery_secret_key"), user).unwrap(),
            root
        );
    }
}

#[test]
fn identity_vectors() {
    let f = fixture("identity_vectors.json");
    let d = &f["delivery"];
    let secret = h32(d, "signing_secret_key");
    assert_eq!(signing_public_key(&secret), s(d, "signing_public_key"));
    let fields = &d["fields"];
    let sealed: SealedKey = serde_json::from_value(fields["sealed"].clone()).unwrap();
    let delivery = DeliveryFields {
        project_id: s(fields, "projectId"),
        recipient_id: s(fields, "recipientId"),
        key_id: s(fields, "keyId"),
        sealed: &sealed,
    };
    assert_eq!(
        hex::encode(delivery_message(&delivery).unwrap()),
        s(d, "message")
    );
    assert_eq!(
        sign_delivery(&secret, &delivery).unwrap(),
        s(d, "signature")
    );
    assert!(verify_delivery(
        s(d, "signing_public_key"),
        s(d, "signature"),
        &delivery
    ));
    let moved = DeliveryFields {
        recipient_id: "0190a6f0-0000-7000-8000-0000000000e2",
        ..delivery
    };
    assert!(!verify_delivery(
        s(d, "signing_public_key"),
        s(d, "signature"),
        &moved
    ));
    assert!(!verify_delivery(s(d, "signing_public_key"), "zz", &moved));

    let n = &f["safety_number"];
    let side = |v: &'_ Value| -> (String, String, String) {
        (
            s(v, "userId").into(),
            s(v, "publicKey").into(),
            s(v, "signingKey").into(),
        )
    };
    let (a, b) = (side(&n["a"]), side(&n["b"]));
    let ka = IdentityKeys {
        user_id: &a.0,
        public_key: &a.1,
        signing_key: &a.2,
    };
    let kb = IdentityKeys {
        user_id: &b.0,
        public_key: &b.1,
        signing_key: &b.2,
    };
    assert_eq!(safety_number(&ka, &kb).unwrap(), s(n, "number"));
    assert_eq!(safety_number(&kb, &ka).unwrap(), s(n, "number"));
}

#[test]
fn recovery_challenge_vectors() {
    for v in fixture("recovery_challenge_vectors.json")["vectors"]
        .as_array()
        .unwrap()
    {
        let sealed: SealedKey = serde_json::from_value(v["sealed"].clone()).unwrap();
        let secret = h32(v, "recipient_secret_key");
        assert_eq!(x25519_public_key(&secret), s(v, "recipient_public_key"));
        assert_eq!(
            hex::encode(unseal_key(&sealed, &secret).unwrap()),
            s(v, "nonce")
        );
        // Sealing with the vector's ephemeral key and IV reproduces it.
        let resealed = seal_key_with(
            &from_hex(s(v, "nonce")).unwrap(),
            s(v, "recipient_public_key"),
            h32(v, "ephemeral_secret_key"),
            from_hex(s(v, "iv")).unwrap().try_into().unwrap(),
        )
        .unwrap();
        assert_eq!(resealed, sealed);
    }
}

#[test]
fn recovery_key_vectors() {
    let f = fixture("recovery_key_vectors.json");
    for v in f["vectors"].as_array().unwrap() {
        let keys = derive_recovery_keys(s(v, "phrase"), s(v, "salt")).unwrap();
        assert_eq!(
            hex::encode(keys.wrap_key),
            s(v, "wrap_key"),
            "{}",
            s(v, "name")
        );
        assert_eq!(hex::encode(keys.auth_secret_key), s(v, "auth_secret_key"));
        assert_eq!(keys.auth_public_key, s(v, "auth_public_key"));
    }
    for phrase in f["invalid"].as_array().unwrap() {
        assert!(derive_recovery_keys(phrase.as_str().unwrap(), "00").is_err());
    }
}

#[test]
fn envelope_vectors() {
    let f = fixture("envelope_vectors.json");
    for p in f["padding"].as_array().unwrap() {
        assert_eq!(
            padded_length(p["n"].as_u64().unwrap() as usize) as u64,
            p["padded"].as_u64().unwrap()
        );
    }
    for v in f["field_v2"].as_array().unwrap() {
        let scope = match s(v, "scope").strip_prefix("project:") {
            Some(id) => KeyScope::Project(id.into()),
            None => KeyScope::Personal,
        };
        let at = FieldLocation {
            entity: s(v, "entity"),
            entity_id: s(v, "entity_id"),
            field: s(v, "field"),
        };
        let env = FieldEnvelope::from_value(&v["envelope"]).unwrap();
        let key = h32(v, "key");
        assert_eq!(decrypt_field(&key, &scope, at, &env).unwrap(), v["value"]);
        let again = encrypt_field_with_iv(
            &key,
            &env.kid,
            &scope,
            at,
            &v["value"],
            iv_of(&v["envelope"]),
        )
        .unwrap();
        assert_eq!(again, env, "re-encrypting {}", v["value"]);
        let elsewhere = FieldLocation {
            field: "other",
            ..at
        };
        assert!(decrypt_field(&key, &scope, elsewhere, &env).is_err());
        assert!(decrypt_field(&key, &KeyScope::Project("x".into()), at, &env).is_err());
        assert!(is_encrypted_envelope(&v["envelope"]));
    }
    for v in f["field_v1"].as_array().unwrap() {
        let env = &v["envelope"];
        assert!(is_encrypted_envelope(env));
        assert_eq!(
            decrypt_json(&h32(v, "key"), &payload(env)).unwrap(),
            v["value"]
        );
    }
    let p = &f["project_key"];
    let dek = h32(p, "dek");
    let pek = h32(p, "pek");
    assert_eq!(project_key_id(&pek), s(p, "key_id"));
    let wrapped = &p["wrapped"];
    assert_eq!(
        unwrap_project_key(
            &payload(wrapped),
            wrapped.get("v"),
            &dek,
            s(p, "project_id")
        )
        .unwrap(),
        pek
    );
    assert!(unwrap_project_key(&payload(wrapped), wrapped.get("v"), &dek, "other").is_err());
    let again = wrap_project_key_with_iv(&pek, &dek, s(p, "project_id"), iv_of(wrapped)).unwrap();
    assert_eq!(serde_json::to_value(again).unwrap(), *wrapped);
    assert_eq!(
        unwrap_project_key(&payload(&p["unbound"]), None, &dek, "any").unwrap(),
        pek
    );

    let k = &f["signing_key"];
    let secret = h32(k, "secret_key");
    assert_eq!(signing_public_key(&secret), s(k, "public_key"));
    assert_eq!(
        unwrap_signing_key(&payload(&k["wrapped"]), &h32(k, "dek"), s(k, "public_key")).unwrap(),
        secret
    );
    let again = wrap_signing_key_with_iv(&secret, &h32(k, "dek"), iv_of(&k["wrapped"])).unwrap();
    assert_eq!(again, payload(&k["wrapped"]));

    let sealed = &f["sealed"];
    let box_: SealedKey = serde_json::from_value(sealed["sealed"].clone()).unwrap();
    assert_eq!(
        hex::encode(unseal_key(&box_, &h32(sealed, "recipient_secret_key")).unwrap()),
        s(sealed, "key")
    );
}

#[test]
fn envelopes_are_recognised_by_shape() {
    assert!(is_encrypted_envelope(
        &json!({"__enc": 2, "kid": "dek", "iv": "a", "ct": "b"})
    ));
    assert!(is_encrypted_envelope(
        &json!({"__enc": 1, "iv": "a", "ct": "b"})
    ));
    assert!(!is_encrypted_envelope(
        &json!({"__enc": 2, "iv": "a", "ct": "b"})
    ));
    assert!(!is_encrypted_envelope(&json!({"iv": "a", "ct": "b"})));
    assert!(!is_encrypted_envelope(&json!("text")));
}
