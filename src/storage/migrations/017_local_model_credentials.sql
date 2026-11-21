-- Account-owned encrypted model credentials. Secret material never appears in config exports.
CREATE TABLE local_model_credentials (
  config_id TEXT PRIMARY KEY REFERENCES model_configs(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_local_credentials_owner ON local_model_credentials(owner_user_id);

CREATE TABLE local_search_credentials (
  owner_user_id TEXT PRIMARY KEY REFERENCES users(id),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
