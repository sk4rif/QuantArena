pub mod economy;
pub mod entities;
pub mod placement;
pub mod spatial;
pub mod world;

use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use axum::extract::ws::Utf8Bytes;
use tokio::sync::{broadcast, mpsc, oneshot};

use super::{
    config::{PUBLISH_RATE, TICK_RATE},
    protocol::{Bootstrap, EntityId, ServerMessage},
};

use economy::Tier;
pub use world::GameWorld;

/// JSON for one delta, serialized once. `Utf8Bytes` clones by reference count,
/// so each socket can take a copy without copying the payload.
#[derive(Debug, Clone)]
pub struct PublishedDelta {
    pub sequence: u64,
    pub text: Utf8Bytes,
}

/// 15 Hz publishes. 256 slots keep roughly 17 seconds of deltas so a slow
/// socket can catch up before the broadcast reports `Lagged`.
const DELTA_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Default)]
struct ReplicaWatch {
    resync_pending: bool,
    consecutive_digest_mismatches: u8,
    last_bootstrap: Option<Instant>,
}

struct Session {
    direct: mpsc::Sender<ServerMessage>,
    watch: ReplicaWatch,
}

/// Browser inputs carry a replica digest. A known sequence must mismatch twice
/// before a bootstrap, and pushes are limited to one per second — the same
/// budget as an explicit resync. An unknown sequence still resyncs on the
/// first report once that budget is free.
fn observe_replica(
    watch: &mut ReplicaWatch,
    sequence_known: bool,
    digest_matches: bool,
    now: Instant,
) -> Option<&'static str> {
    if digest_matches {
        watch.resync_pending = false;
        watch.consecutive_digest_mismatches = 0;
        return None;
    }
    if watch.resync_pending {
        return None;
    }
    let reason = if sequence_known {
        if watch.consecutive_digest_mismatches < 2 {
            watch.consecutive_digest_mismatches += 1;
        }
        if watch.consecutive_digest_mismatches < 2 {
            return None;
        }
        "digestMismatch"
    } else {
        "sequenceUnknown"
    };
    let cooled_down = watch
        .last_bootstrap
        .is_none_or(|last| now.saturating_duration_since(last) >= Duration::from_secs(1));
    cooled_down.then_some(reason)
}

fn note_bootstrap_pushed(watch: &mut ReplicaWatch, now: Instant) {
    watch.resync_pending = true;
    watch.consecutive_digest_mismatches = 0;
    watch.last_bootstrap = Some(now);
}

/// The client's view of the replicated state, used to detect drift.
/// Bot connections omit it: they consume the same deltas but are not checked.
#[derive(Debug, Clone, Copy)]
pub struct ReplicaState {
    pub sequence: u64,
    pub digest: u64,
}

pub enum WorldCommand {
    Join {
        name: String,
        skin: String,
        spectate: bool,
        direct_tx: mpsc::Sender<ServerMessage>,
        reply: oneshot::Sender<(EntityId, Bootstrap)>,
    },
    Input {
        player_id: EntityId,
        input_seq: u32,
        aim: f32,
        boosting: bool,
        replica: Option<ReplicaState>,
    },
    Reenter {
        player_id: EntityId,
        replica: Option<ReplicaState>,
    },
    CashOut {
        player_id: EntityId,
        replica: Option<ReplicaState>,
    },
    CancelCashOut {
        player_id: EntityId,
        replica: Option<ReplicaState>,
    },
    Bootstrap {
        player_id: EntityId,
        reason: String,
        reply: oneshot::Sender<Bootstrap>,
    },
    Disconnect {
        player_id: EntityId,
    },
}

#[derive(Clone)]
pub struct WorldHandle {
    pub commands: mpsc::Sender<WorldCommand>,
    deltas: broadcast::Sender<PublishedDelta>,
}

impl WorldHandle {
    pub fn subscribe(&self) -> broadcast::Receiver<PublishedDelta> {
        self.deltas.subscribe()
    }
}

pub fn spawn_world(tier: Tier) -> WorldHandle {
    let (command_tx, mut command_rx) = mpsc::channel(512);
    let (delta_tx, _) = broadcast::channel(DELTA_CHANNEL_CAPACITY);
    let handle = WorldHandle {
        commands: command_tx,
        deltas: delta_tx.clone(),
    };

    tokio::spawn(async move {
        let mut world = GameWorld::new(tier);
        let mut sessions: BTreeMap<EntityId, Session> = BTreeMap::new();
        let mut tick_interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(TICK_RATE)));
        let mut publish_interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(PUBLISH_RATE)));
        tick_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        publish_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Fixed priority when a tick, a publish, and queued commands are ready
        // together. Without `biased;`, Tokio picks a ready branch at random, so
        // an input or cash-out already sitting in the channel can miss the tick
        // it arrived in time for and land on the next one.
        //
        // 1. Commands already in the channel, in arrival order. The channel is
        //    FIFO, and each loop takes one command, so a backlog drains before
        //    the tick instead of being shuffled. Applying those commands first
        //    is the fair reading of "this action arrived before the tick": the
        //    cash-out deadline and the movement for this step include it.
        //    Handlers do not await, so a finite backlog cannot postpone the
        //    tick past the commands that were already waiting. A command that
        //    arrives while the tick runs waits for the next loop.
        // 2. The simulation tick, once the queue is empty.
        // 3. A state publish, so a snapshot taken on the same wakeup includes
        //    the tick that just ran.
        loop {
            tokio::select! {
                biased;
                command = command_rx.recv() => {
                    let Some(command) = command else { break };
                    match command {
                        WorldCommand::Join { name, skin, spectate, direct_tx, reply } => {
                            let id = if spectate {
                                world.spectate()
                            } else {
                                let id = world.join(name, skin);
                                publish(&mut world, &delta_tx);
                                id
                            };
                            sessions.insert(
                                id,
                                Session {
                                    direct: direct_tx,
                                    watch: ReplicaWatch::default(),
                                },
                            );
                            let reason = if spectate { "spectating" } else { "joined" };
                            let _ = reply.send((id, world.bootstrap(id, reason)));
                        }
                        WorldCommand::Input {
                            player_id,
                            input_seq,
                            aim,
                            boosting,
                            replica,
                        } => {
                            check_replica(&world, player_id, replica, &mut sessions);
                            world.input(player_id, input_seq, aim, boosting);
                        }
                        WorldCommand::Reenter { player_id, replica } => {
                            check_replica(&world, player_id, replica, &mut sessions);
                            if world.reenter(player_id) {
                                if let Some(session) = sessions.get(&player_id) {
                                    let _ = session.direct.try_send(ServerMessage::Entered { ticket_nanos: world.ticket().0 });
                                }
                                publish(&mut world, &delta_tx);
                            }
                        }
                        WorldCommand::CashOut { player_id, replica } => {
                            check_replica(&world, player_id, replica, &mut sessions);
                            if let Some((completes_at_tick, inheritance_tax_basis_points)) =
                                world.request_cash_out(player_id)
                                && let Some(session) = sessions.get(&player_id)
                            {
                                let _ = session.direct.try_send(ServerMessage::CashOutPending {
                                    completes_at_tick,
                                    inheritance_tax_basis_points,
                                });
                            }
                        }
                        WorldCommand::CancelCashOut { player_id, replica } => {
                            check_replica(&world, player_id, replica, &mut sessions);
                            if world.cancel_cash_out(player_id)
                                && let Some(session) = sessions.get(&player_id)
                            {
                                let _ = session.direct.try_send(ServerMessage::CashOutCanceled);
                            }
                        }
                        WorldCommand::Bootstrap { player_id, reason, reply } => {
                            let _ = reply.send(world.bootstrap(player_id, reason));
                        }
                        WorldCommand::Disconnect { player_id } => {
                            sessions.remove(&player_id);
                            if world.disconnect(player_id) {
                                tracing::info!(player_id, "disconnected snake abandoned");
                            }
                        }
                    }
                }
                _ = tick_interval.tick() => {
                    for elimination in world.tick() {
                        if let Some(session) = sessions.get(&elimination.player_id) {
                            let _ = session.direct.try_send(ServerMessage::Eliminated {
                                reason: elimination.reason,
                                final_worth_nanos: elimination.final_worth.0,
                                ticket_nanos: world.ticket().0,
                                collision_id: elimination.collision_id,
                            });
                        }
                    }
                    let receipts = world.complete_cash_outs();
                    let completed = !receipts.is_empty();
                    for receipt in receipts {
                        if let Some(session) = sessions.get(&receipt.player_id) {
                            let _ = session.direct.try_send(ServerMessage::CashOutReceipt(receipt));
                        }
                    }
                    if completed {
                        publish(&mut world, &delta_tx);
                    }
                },
                _ = publish_interval.tick() => publish(&mut world, &delta_tx),
            }
        }
    });

    handle
}

fn publish(world: &mut GameWorld, sender: &broadcast::Sender<PublishedDelta>) {
    let delta = world.publish_delta();
    let sequence = delta.sequence;
    match serde_json::to_string(&ServerMessage::Delta(delta)) {
        Ok(text) => {
            let _ = sender.send(PublishedDelta {
                sequence,
                text: Utf8Bytes::from(text),
            });
        }
        Err(error) => tracing::error!(%error, "failed to serialize world delta"),
    }
}

fn check_replica(
    world: &GameWorld,
    player_id: EntityId,
    replica: Option<ReplicaState>,
    sessions: &mut BTreeMap<EntityId, Session>,
) {
    let Some(ReplicaState { sequence, digest }) = replica else {
        return;
    };
    let Some(session) = sessions.get_mut(&player_id) else {
        return;
    };
    let now = Instant::now();
    let Some(reason) = observe_replica(
        &mut session.watch,
        world.sequence_is_known(sequence),
        world.digest_matches(sequence, digest),
        now,
    ) else {
        return;
    };
    if session
        .direct
        .try_send(ServerMessage::Bootstrap(world.bootstrap(player_id, reason)))
        .is_ok()
    {
        note_bootstrap_pushed(&mut session.watch, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_digest_mismatch_waits_for_a_second_consecutive_failure() {
        let mut watch = ReplicaWatch::default();
        let now = Instant::now();
        assert_eq!(observe_replica(&mut watch, true, false, now), None);
        assert_eq!(observe_replica(&mut watch, true, true, now), None);
        assert_eq!(observe_replica(&mut watch, true, false, now), None);
        assert_eq!(
            observe_replica(&mut watch, true, false, now),
            Some("digestMismatch")
        );
        note_bootstrap_pushed(&mut watch, now);
        assert_eq!(observe_replica(&mut watch, true, false, now), None);
    }

    #[test]
    fn unknown_sequence_bootstraps_immediately_inside_the_rate_limit() {
        let mut watch = ReplicaWatch::default();
        let now = Instant::now();
        assert_eq!(
            observe_replica(&mut watch, false, false, now),
            Some("sequenceUnknown")
        );
        note_bootstrap_pushed(&mut watch, now);
        assert_eq!(
            observe_replica(&mut watch, false, false, now + Duration::from_millis(500)),
            None
        );
        let cooled = now + Duration::from_secs(2);
        assert_eq!(observe_replica(&mut watch, false, false, cooled), None);
        assert_eq!(observe_replica(&mut watch, true, true, cooled), None);
        assert_eq!(
            observe_replica(&mut watch, false, false, cooled),
            Some("sequenceUnknown")
        );
    }

    #[test]
    fn second_digest_mismatch_respects_the_one_second_bootstrap_limit() {
        let mut watch = ReplicaWatch::default();
        let now = Instant::now();
        assert_eq!(observe_replica(&mut watch, true, false, now), None);
        assert_eq!(
            observe_replica(&mut watch, true, false, now),
            Some("digestMismatch")
        );
        note_bootstrap_pushed(&mut watch, now);
        assert_eq!(observe_replica(&mut watch, true, true, now), None);

        let soon = now + Duration::from_millis(200);
        assert_eq!(observe_replica(&mut watch, true, false, soon), None);
        assert_eq!(observe_replica(&mut watch, true, false, soon), None);
        assert_eq!(
            observe_replica(&mut watch, true, false, now + Duration::from_secs(1)),
            Some("digestMismatch")
        );
    }

    fn tick_period() -> Duration {
        Duration::from_secs_f64(1.0 / f64::from(super::super::config::TICK_RATE))
    }

    async fn join_player(handle: &WorldHandle, name: &str) -> (EntityId, Bootstrap) {
        let (direct_tx, _direct_rx) = mpsc::channel(8);
        let (reply_tx, reply_rx) = oneshot::channel();
        handle
            .commands
            .send(WorldCommand::Join {
                name: name.to_owned(),
                skin: "red".to_owned(),
                spectate: false,
                direct_tx,
                reply: reply_tx,
            })
            .await
            .unwrap();
        reply_rx.await.unwrap()
    }

    async fn request_bootstrap(handle: &WorldHandle, player_id: EntityId) -> Bootstrap {
        let (reply_tx, reply_rx) = oneshot::channel();
        handle
            .commands
            .send(WorldCommand::Bootstrap {
                player_id,
                reason: "test".to_owned(),
                reply: reply_tx,
            })
            .await
            .unwrap();
        reply_rx.await.unwrap()
    }

    /// The interval's first tick is ready as soon as the task starts. Let that
    /// tick and the matching publish finish so the test's later wakeup is the
    /// one under examination.
    async fn settle_startup(handle: &WorldHandle, player_id: EntityId) -> u64 {
        tokio::task::yield_now().await;
        let joined = request_bootstrap(handle, player_id).await;
        let again = request_bootstrap(handle, player_id).await;
        assert_eq!(again.tick, joined.tick);
        joined.tick
    }

    #[tokio::test(start_paused = true)]
    async fn queued_commands_apply_in_arrival_order_before_a_coincident_tick() {
        let handle = spawn_world(Tier::Paper);
        tokio::task::yield_now().await;
        let (player_id, joined) = join_player(&handle, "Ada").await;
        let tick_before = settle_startup(&handle, player_id).await;
        assert_eq!(tick_before, joined.tick);
        assert!(joined.cash_out_completes_at_tick.is_none());

        // Cancel is queued first, so it is a no-op. Cash-out is queued second
        // and must still be applied, on the clock from before the tick.
        handle
            .commands
            .try_send(WorldCommand::CancelCashOut {
                player_id,
                replica: None,
            })
            .unwrap();
        handle
            .commands
            .try_send(WorldCommand::CashOut {
                player_id,
                replica: None,
            })
            .unwrap();
        // The timer wheel rounds deadlines up to the next millisecond, so step
        // a little past one 30 Hz period. That is still short of a second tick
        // and of the 15 Hz publish.
        tokio::time::advance(tick_period() + Duration::from_millis(5)).await;
        tokio::task::yield_now().await;

        let after = request_bootstrap(&handle, player_id).await;
        assert_eq!(after.tick, tick_before + 1);
        assert_eq!(
            after.cash_out_completes_at_tick,
            Some(tick_before + world::CASH_OUT_DELAY_TICKS)
        );
    }

    /// Same priority as `spawn_world`: a tick that is already due does not run
    /// until commands queued ahead of it have been applied, in arrival order.
    #[tokio::test(start_paused = true)]
    async fn due_tick_waits_until_queued_commands_are_applied_in_order() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut tick = tokio::time::interval(tick_period());
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tick.tick().await;

        {
            let waker = std::task::Waker::noop();
            let mut cx = std::task::Context::from_waker(waker);
            let mut pending_tick = std::pin::pin!(tick.tick());
            assert!(std::future::Future::poll(pending_tick.as_mut(), &mut cx).is_pending());
        }

        tokio::time::advance(tick_period() + Duration::from_millis(5)).await;
        tx.try_send(1).unwrap();
        tx.try_send(2).unwrap();

        let mut events = Vec::new();
        loop {
            tokio::select! {
                biased;
                value = rx.recv() => events.push(value.unwrap()),
                _ = tick.tick() => {
                    events.push(0);
                    break;
                }
            }
        }
        assert_eq!(events, vec![1, 2, 0]);
    }
}
