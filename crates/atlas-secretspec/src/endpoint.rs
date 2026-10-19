//! The Secret Provider Protocol endpoint: a [`ProviderHandler`] over one vault session.
//!
//! The Atlas client is blocking, so one worker thread owns the session and runs the operations
//! in order; the async handler only hands them over. The session opens on the first operation
//! (not during `rpc.initialize`, which has a short startup deadline), and a sign-in that failed
//! for good (an expired, revoked or wrong token) is not retried for the rest of the session.

use std::sync::mpsc;
use std::sync::OnceLock;

use async_trait::async_trait;
use atlas_client::client::AtlasClient;
use secretspec_ipc::error::{ErrorKind, RpcError};
use secretspec_ipc::protocol::callback::CredentialParams;
use secretspec_ipc::protocol::provider::{
    self as wire, Address, CoordinateName, InitializeApplication, Metadata, Persistence,
    ResolveAddressResult,
};
use secretspec_ipc::provider::{request_credential, ProvidedSecret, ProviderHandler, SecretValue};
use secretspec_ipc::server::{RequestContext, RpcResult};

use crate::{display_uri, server_url, target, Fault, Settings, Target};

/// The name of the credential the endpoint asks SecretSpec for when `ATLAS_TOKEN` is not set.
pub const TOKEN_CREDENTIAL: &str = "token";

/// The session the worker owns.
struct Backend {
    server_url: String,
    token: Option<String>,
    state_dir: Option<std::path::PathBuf>,
    client: Option<AtlasClient>,
    /// A sign-in failure that another attempt would only repeat.
    failed: Option<Fault>,
}

impl Backend {
    fn client(&mut self) -> Result<&mut AtlasClient, Fault> {
        if let Some(fault) = &self.failed {
            return Err(fault.clone());
        }
        if self.client.is_none() {
            let Some(token) = self.token.as_deref() else {
                let fault = Fault::new(
                    ErrorKind::InteractionRequired,
                    "no_token",
                    "set ATLAS_TOKEN to an Atlas Vault API token (or store the provider credential \
                     \"token\" with `secretspec config provider login`)",
                );
                self.failed = Some(fault.clone());
                return Err(fault);
            };
            match crate::connect(&self.server_url, token, self.state_dir.clone()) {
                Ok(client) => self.client = Some(client),
                Err(fault) => {
                    if fault.kind != ErrorKind::Unavailable {
                        self.failed = Some(fault.clone());
                    }
                    return Err(fault);
                }
            }
        }
        Ok(self.client.as_mut().expect("connected"))
    }
}

type Job = Box<dyn FnOnce(&mut Backend) + Send>;

struct Worker {
    jobs: mpsc::Sender<Job>,
}

impl Worker {
    fn start(mut backend: Backend) -> Self {
        let (jobs, rx) = mpsc::channel::<Job>();
        std::thread::spawn(move || {
            for job in rx {
                job(&mut backend);
            }
        });
        Self { jobs }
    }

    async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut AtlasClient) -> Result<T, Fault> + Send + 'static,
    ) -> RpcResult<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.jobs
            .send(Box::new(move |backend: &mut Backend| {
                let _ = tx.send(backend.client().and_then(f));
            }))
            .map_err(|_| RpcError::new(ErrorKind::Internal))?;
        let result = rx.await.map_err(|_| RpcError::new(ErrorKind::Internal))?;
        result.map_err(|fault| rpc_error(&fault))
    }
}

/// The wire error for a fault: its kind only, never backend text.
fn rpc_error(fault: &Fault) -> RpcError {
    match fault.kind {
        ErrorKind::Unavailable => RpcError::unavailable(None),
        ErrorKind::InteractionRequired => RpcError::interaction_required(None),
        kind => RpcError::new(kind),
    }
}

/// The Atlas Vault provider endpoint.
pub struct AtlasProvider {
    settings: Settings,
    worker: OnceLock<Worker>,
}

impl AtlasProvider {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings,
            worker: OnceLock::new(),
        }
    }

    fn worker(&self) -> RpcResult<&Worker> {
        self.worker
            .get()
            .ok_or_else(|| RpcError::new(ErrorKind::Internal))
    }

    fn target(address: &Address) -> RpcResult<Target> {
        target(address).map_err(|fault| rpc_error(&fault))
    }
}

#[async_trait]
impl ProviderHandler for AtlasProvider {
    fn capabilities(&self) -> Vec<String> {
        [
            wire::method::RESOLVE_ADDRESS,
            wire::method::GET,
            wire::method::EXISTS,
            wire::method::SET,
            wire::method::DELETE,
            wire::method::CHECK_WRITABLE,
            wire::method::CHECK_DELETABLE,
            wire::method::DESCRIBE_WRITE_TARGET,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }

    async fn initialize(
        &self,
        context: &RequestContext,
        application: InitializeApplication,
    ) -> RpcResult<Metadata> {
        let server_url = server_url(
            &application.uri,
            &application.scheme,
            self.settings.url.as_deref(),
        )
        .map_err(|fault| rpc_error(&fault))?;
        // The environment first (CI); otherwise the credential SecretSpec keeps for this provider
        // (`secretspec config provider login`, or an alias's `credentials = { token = … }`).
        let token = match &self.settings.token {
            Some(token) => Some(token.clone()),
            None => request_credential(
                context,
                CredentialParams {
                    name: TOKEN_CREDENTIAL.into(),
                    scope: display_uri(&server_url),
                    required: false,
                },
            )
            .await?
            .map(|value| value.expose().trim().to_owned())
            .filter(|t| !t.is_empty()),
        };
        let identity = display_uri(&server_url);
        let worker = Worker::start(Backend {
            server_url,
            token,
            state_dir: self.settings.state_dir.clone(),
            client: None,
            failed: None,
        });
        self.worker
            .set(worker)
            .map_err(|_| RpcError::new(ErrorKind::Conflict))?;
        Ok(Metadata {
            name: application.scheme,
            display_uri: identity.clone(),
            supported_coordinates: vec![CoordinateName::Field, CoordinateName::Vault],
            generated_value_persistence: Persistence::Persist,
            prompted_value_persistence: Persistence::Persist,
            storage_identity: identity.clone(),
            entry_container_identity: identity,
            physical_store_path: None,
        })
    }

    async fn resolve_address(
        &self,
        _context: RequestContext,
        address: Address,
    ) -> RpcResult<ResolveAddressResult> {
        Ok(ResolveAddressResult {
            coordinates: Self::target(&address)?.coordinates(),
        })
    }

    async fn get(
        &self,
        _context: RequestContext,
        address: Address,
    ) -> RpcResult<Option<ProvidedSecret>> {
        let target = Self::target(&address)?;
        let value = self
            .worker()?
            .run(move |client| crate::read(client, &target))
            .await?;
        Ok(value.map(|v| ProvidedSecret::new(v, None)))
    }

    async fn exists(&self, _context: RequestContext, address: Address) -> RpcResult<bool> {
        let target = Self::target(&address)?;
        self.worker()?
            .run(move |client| crate::read(client, &target).map(|v| v.is_some()))
            .await
    }

    async fn set(
        &self,
        _context: RequestContext,
        address: Address,
        value: SecretValue,
    ) -> RpcResult<()> {
        let target = Self::target(&address)?;
        self.worker()?
            .run(move |client| crate::write(client, &target, value.expose()))
            .await
    }

    async fn delete(&self, _context: RequestContext, address: Address) -> RpcResult<bool> {
        let target = Self::target(&address)?;
        self.worker()?
            .run(move |client| crate::remove(client, &target))
            .await
    }

    async fn check_writable(&self, _context: RequestContext, address: Address) -> RpcResult<()> {
        Self::target(&address)?;
        self.worker()?
            .run(|client| crate::require_write(client))
            .await
    }

    async fn check_deletable(&self, context: RequestContext, address: Address) -> RpcResult<()> {
        self.check_writable(context, address).await
    }

    async fn describe_write_target(
        &self,
        _context: RequestContext,
        address: Address,
    ) -> RpcResult<String> {
        Ok(Self::target(&address)?.describe())
    }
}
