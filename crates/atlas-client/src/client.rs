//! A headless client for an app, signed in with an API token: the session that holds the decrypted
//! account in memory, the clock and the zone its rules read. The apps' own operations sit on top,
//! in their repositories (todo's `TodoClient`, the journal's `JournalClient`, the vault's
//! `VaultClient` each wrap this one).

use jiff::tz::TimeZone;

use crate::error::Result;
use crate::session::{ConnectOptions, Session};
use crate::store::now_ms;
use crate::zoned::resolve_time_zone;

pub struct AtlasClient {
    session: Session,
    time_zone: TimeZone,
    now: Box<dyn Fn() -> i64 + Send>,
}

impl AtlasClient {
    /// Sign in with the token, unwrap the keys it carries, pull and decrypt the account.
    pub fn connect(opts: ConnectOptions) -> Result<Self> {
        let time_zone = resolve_time_zone(opts.time_zone.as_deref());
        let session = Session::connect(opts)?;
        Ok(Self {
            session,
            time_zone,
            now: Box::new(|| now_ms() as i64),
        })
    }

    /// For tests: the clock the rules read.
    pub fn set_now(&mut self, now: Box<dyn Fn() -> i64 + Send>) {
        self.now = now;
    }

    /// The clock the rules read, in epoch milliseconds.
    pub fn now(&self) -> i64 {
        (self.now)()
    }

    /// The zone dates are read and shown in.
    pub fn time_zone(&self) -> &TimeZone {
        &self.time_zone
    }

    pub fn user_id(&self) -> &str {
        &self.session.user_id
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn session_mut(&mut self) -> &mut Session {
        &mut self.session
    }

    /// The server cursor this client has pulled up to.
    pub fn cursor(&self) -> u64 {
        self.session.sync.cursor()
    }

    /// Push pending writes; an error when any did not reach the server.
    pub fn push(&mut self) -> Result<()> {
        self.session.push()
    }
}
