//! The live side of sync: per-user broadcast channels, the registry of open sockets, and the
//! single-use tickets a socket opens with.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::sync::{broadcast, Notify};
use uuid::Uuid;

/// How often the server pings an open sync socket.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// How long a socket ticket can be redeemed after issue.
pub(super) const WS_TICKET_TTL: Duration = Duration::from_secs(30);

/// Unredeemed tickets one user may hold; issuing another drops that user's oldest.
const WS_TICKETS_PER_USER: usize = 8;

/// Unredeemed tickets across all users. They live in memory, so the map is bounded: when full
/// of live tickets, asking for another answers 429.
const MAX_WS_TICKETS: usize = 10_000;

/// Per-user broadcast fan-out for realtime op delivery, plus a registry of open sync sockets
/// (so ending a session can close them) and the single-use tickets sockets open with
/// ([`ws_ticket`](super::ws::ws_ticket)). Tickets live in this process's memory, which suffices
/// for one instance.
pub struct SyncHub {
    channels: Mutex<HashMap<Uuid, broadcast::Sender<String>>>,
    sockets: Mutex<HashMap<Uuid, Vec<SocketEntry>>>,
    next_socket: AtomicU64,
    pub(super) ping_interval: Duration,
    tickets: Mutex<WsTickets>,
}

/// The unredeemed socket tickets, and each user's in the order they were issued.
#[derive(Default)]
struct WsTickets {
    by_ticket: HashMap<String, WsTicket>,
    by_user: HashMap<Uuid, VecDeque<String>>,
}

impl WsTickets {
    fn remove(&mut self, ticket: &str) -> Option<WsTicket> {
        let found = self.by_ticket.remove(ticket)?;
        if let Entry::Occupied(mut mine) = self.by_user.entry(found.user) {
            mine.get_mut().retain(|t| t != ticket);
            if mine.get().is_empty() {
                mine.remove();
            }
        }
        Some(found)
    }

    fn sweep_expired(&mut self, now: Instant) {
        self.by_ticket
            .retain(|_, t| now.duration_since(t.issued) < WS_TICKET_TTL);
        let live = &self.by_ticket;
        self.by_user.retain(|_, mine| {
            mine.retain(|t| live.contains_key(t));
            !mine.is_empty()
        });
    }
}

/// What a socket ticket was issued for. Not `Debug`, so neither it nor the ticket reaches a log.
pub(super) struct WsTicket {
    pub(super) user: Uuid,
    pub(super) device: Option<Uuid>,
    /// The access token's expiry (unix seconds).
    pub(super) token_expires_at: i64,
    issued: Instant,
}

/// One open socket in the registry: its device (the token's `did`) and the handle that closes it.
struct SocketEntry {
    id: u64,
    device: Option<Uuid>,
    close: Arc<Notify>,
}

impl Default for SyncHub {
    fn default() -> Self {
        Self::with_ping_interval(PING_INTERVAL)
    }
}

impl SyncHub {
    /// A hub whose sockets are pinged every `ping_interval`.
    pub fn with_ping_interval(ping_interval: Duration) -> Self {
        Self {
            channels: Mutex::default(),
            sockets: Mutex::default(),
            next_socket: AtomicU64::new(0),
            ping_interval,
            tickets: Mutex::default(),
        }
    }

    /// Issue a ticket that opens one sync socket as `user`'s `device`: 256 random bits,
    /// hex-encoded. `None` while [`MAX_WS_TICKETS`] live tickets are out.
    pub(super) fn issue_ticket(
        &self,
        user: Uuid,
        device: Option<Uuid>,
        token_expires_at: i64,
        now: Instant,
    ) -> Option<String> {
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        let oldest = tickets
            .by_user
            .get(&user)
            .filter(|mine| mine.len() >= WS_TICKETS_PER_USER)
            .and_then(|mine| mine.front().cloned());
        if let Some(oldest) = oldest {
            tickets.remove(&oldest);
        }
        if tickets.by_ticket.len() >= MAX_WS_TICKETS {
            tickets.sweep_expired(now);
            if tickets.by_ticket.len() >= MAX_WS_TICKETS {
                return None;
            }
        }
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let ticket = hex::encode(bytes);
        tickets.by_ticket.insert(
            ticket.clone(),
            WsTicket {
                user,
                device,
                token_expires_at,
                issued: now,
            },
        );
        tickets
            .by_user
            .entry(user)
            .or_default()
            .push_back(ticket.clone());
        Some(ticket)
    }

    /// Redeem a ticket; it is removed whether or not valid, so it opens one socket at most.
    pub(super) fn redeem_ticket(&self, ticket: &str, now: Instant) -> Option<WsTicket> {
        let found = self
            .tickets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(ticket)?;
        (now.duration_since(found.issued) < WS_TICKET_TTL).then_some(found)
    }

    /// Close every open sync socket of `user` (code 4403, `session_revoked`); returns how many
    /// were open. Call after the session-ending change commits: the handshake re-checks the
    /// account, so a reconnecting device is refused.
    pub fn close_user_sockets(&self, user: Uuid) -> usize {
        self.close_sockets(user, |_| true)
    }

    /// Close the open sync sockets of one of `user`'s devices; returns how many were open.
    pub fn close_device_sockets(&self, user: Uuid, device: Uuid) -> usize {
        self.close_sockets(user, |entry| entry.device == Some(device))
    }

    fn close_sockets(&self, user: Uuid, matches: impl Fn(&SocketEntry) -> bool) -> usize {
        let sockets = self.sockets.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entries) = sockets.get(&user) else {
            return 0;
        };
        let mut closed = 0;
        for entry in entries.iter().filter(|e| matches(e)) {
            // A stored permit, so a socket not yet waiting still sees it.
            entry.close.notify_one();
            closed += 1;
        }
        closed
    }

    pub(super) fn register_socket(
        self: &Arc<Self>,
        user: Uuid,
        device: Option<Uuid>,
    ) -> SocketHandle {
        let id = self.next_socket.fetch_add(1, AtomicOrdering::Relaxed);
        let close = Arc::new(Notify::new());
        self.sockets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(user)
            .or_default()
            .push(SocketEntry {
                id,
                device,
                close: close.clone(),
            });
        SocketHandle {
            hub: self.clone(),
            user,
            id,
            close,
        }
    }

    pub fn subscribe(&self, user: Uuid) -> broadcast::Receiver<String> {
        let mut map = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        let tx = map.entry(user).or_insert_with(|| broadcast::channel(256).0);
        tx.subscribe()
    }

    pub fn publish(&self, user: Uuid, payload: String) {
        let map = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(tx) = map.get(&user) {
            let _ = tx.send(payload);
        }
    }

    /// Drop a user's channel once their last subscriber is gone. Receiver liveness is checked
    /// under the lock so a concurrent re-subscribe is not lost.
    pub fn unsubscribe(&self, user: Uuid) {
        let mut map = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(tx) = map.get(&user) {
            if tx.receiver_count() == 0 {
                map.remove(&user);
            }
        }
    }
}

pub(super) struct SocketHandle {
    hub: Arc<SyncHub>,
    user: Uuid,
    id: u64,
    pub(super) close: Arc<Notify>,
}

impl Drop for SocketHandle {
    fn drop(&mut self) {
        let mut sockets = self
            .hub
            .sockets
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(entries) = sockets.get_mut(&self.user) {
            entries.retain(|e| e.id != self.id);
            if entries.is_empty() {
                sockets.remove(&self.user);
            }
        }
    }
}

/// A live subscription that prunes the channel when dropped. Owned, so it can be taken before
/// the WebSocket upgrade; dropping it on any path cleans up.
pub(super) struct Subscription {
    hub: Arc<SyncHub>,
    user: Uuid,
    rx: Option<broadcast::Receiver<String>>,
}

impl Subscription {
    pub(super) fn new(hub: &Arc<SyncHub>, user: Uuid) -> Self {
        Self {
            hub: hub.clone(),
            user,
            rx: Some(hub.subscribe(user)),
        }
    }

    pub(super) async fn recv(&mut self) -> Result<String, broadcast::error::RecvError> {
        match self.rx.as_mut() {
            Some(rx) => rx.recv().await,
            None => Err(broadcast::error::RecvError::Closed),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // The receiver must be gone before the count check, or the last device keeps its channel.
        drop(self.rx.take());
        self.hub.unsubscribe(self.user);
    }
}

#[cfg(test)]
impl SyncHub {
    /// Test-only peek into the channel map.
    fn has_channel(&self, user: Uuid) -> bool {
        self.channels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&user)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_opens_one_socket_before_it_expires() {
        let hub = SyncHub::default();
        let (user, device) = (Uuid::now_v7(), Some(Uuid::now_v7()));
        let t0 = Instant::now();
        let ticket = hub.issue_ticket(user, device, 42, t0).unwrap();
        assert_eq!(ticket.len(), 64, "256 random bits, hex");
        assert!(ticket.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(hub.issue_ticket(user, device, 42, t0).unwrap(), ticket);

        let redeemed = hub
            .redeem_ticket(&ticket, t0 + Duration::from_secs(29))
            .unwrap();
        assert_eq!(
            (redeemed.user, redeemed.device, redeemed.token_expires_at),
            (user, device, 42)
        );
        assert!(hub.redeem_ticket(&ticket, t0).is_none(), "single use");
        assert!(hub.redeem_ticket("", t0).is_none());

        let late = hub.issue_ticket(user, device, 42, t0).unwrap();
        assert!(
            hub.redeem_ticket(&late, t0 + WS_TICKET_TTL).is_none(),
            "expired"
        );
    }

    #[test]
    fn unredeemed_tickets_are_bounded() {
        let hub = SyncHub::default();
        let user = Uuid::now_v7();
        let t0 = Instant::now();
        let first: Vec<String> = (0..WS_TICKETS_PER_USER as u64)
            .map(|i| {
                hub.issue_ticket(user, None, 0, t0 + Duration::from_millis(i))
                    .unwrap()
            })
            .collect();
        let newest = hub
            .issue_ticket(user, None, 0, t0 + Duration::from_secs(1))
            .unwrap();
        let later = t0 + Duration::from_secs(2);
        assert!(
            hub.redeem_ticket(&first[0], later).is_none(),
            "a user's oldest ticket makes room"
        );
        assert!(hub.redeem_ticket(&first[1], later).is_some());
        assert!(hub.redeem_ticket(&newest, later).is_some());

        let full = SyncHub::default();
        for _ in 0..MAX_WS_TICKETS {
            full.issue_ticket(Uuid::now_v7(), None, 0, t0).unwrap();
        }
        assert!(
            full.issue_ticket(Uuid::now_v7(), None, 0, t0).is_none(),
            "no room while every ticket is live"
        );
        assert!(
            full.issue_ticket(Uuid::now_v7(), None, 0, t0 + WS_TICKET_TTL)
                .is_some(),
            "expired tickets are swept to make room"
        );
    }

    #[test]
    fn channel_pruned_after_last_receiver_drops() {
        let hub = SyncHub::default();
        let user = Uuid::nil();
        let rx1 = hub.subscribe(user);
        let rx2 = hub.subscribe(user);

        drop(rx1);
        hub.unsubscribe(user);
        assert!(
            hub.has_channel(user),
            "channel must stay while another receiver is alive"
        );

        drop(rx2);
        hub.unsubscribe(user);
        assert!(
            !hub.has_channel(user),
            "channel must be pruned when the last receiver drops"
        );

        // A later reconnect starts fresh.
        let _rx3 = hub.subscribe(user);
        assert!(hub.has_channel(user));
    }
}
