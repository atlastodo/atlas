use serde_json::Value;

use crate::crypto::{CryptoError, InvalidApiToken};

/// Everything a client call can fail with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The server answered with an error status (`ApiError`). `data` is its JSON body.
    #[error("{message}")]
    Api {
        status: u16,
        message: String,
        data: Option<Value>,
        retry_after_ms: Option<u64>,
    },
    /// 426: the server needs a newer sync protocol.
    #[error("upgrade_required")]
    UpgradeRequired { min_protocol: Option<u64> },
    /// The request did not reach the server or its answer did not arrive (`NetworkError`).
    #[error("{0}")]
    Network(String),
    /// A rule of the client refused the call, with a stable code (`AtlasError`).
    #[error("{message}")]
    Atlas { code: String, message: String },
    #[error(transparent)]
    InvalidApiToken(#[from] InvalidApiToken),
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    /// Sync without unlocked keys would push plaintext or store ciphertext as content.
    #[error("the E2EE keyring is locked")]
    E2eeLocked,
    /// A shared project's key is not here, so its content cannot be written yet.
    #[error("no key for shared project {0}")]
    MissingScopeKey(String),
    /// The server's answer is not what the protocol says.
    #[error("{0}")]
    Protocol(String),
}

impl Error {
    pub fn atlas(code: &str, message: impl Into<String>) -> Self {
        Error::Atlas {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// The HTTP status of a server error.
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            Error::UpgradeRequired { .. } => Some(426),
            _ => None,
        }
    }

    /// The `code` of a server error's body (`apiErrorCode`).
    pub fn api_code(&self) -> Option<&str> {
        match self {
            Error::Api { data: Some(d), .. } => d.get("code").and_then(Value::as_str),
            _ => None,
        }
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
