pub mod economy;
pub mod entities;
pub mod placement;
pub mod spatial;
pub mod world;

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use tokio::sync::{broadcast, mpsc, oneshot};

use crate::{
    config::{PUBLISH_RATE, TICK_RATE},
    protocol::{Bootstrap, EntityId, ServerMessage},
};

use economy::{ExitReason, Tier};
pub use world::GameWorld;

#[derive(Debug, Clone)]
pub struct PublishedDelta {
    pub sequence: u64,
    pub text: Arc<str>,
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

pub fn spawn_world(tier: Tier, placement_seed: u64) -> WorldHandle {
    let (command_tx, mut command_rx) = mpsc::channel(512);
    let (delta_tx, _) = broadcast::channel(64);
    let handle = WorldHandle {
        commands: command_tx,
        deltas: delta_tx.clone(),
    };

    tokio::spawn(async move {
        let mut world = GameWorld::new(tier, placement_seed);
        let mut sessions: BTreeMap<EntityId, (mpsc::Sender<ServerMessage>, bool)> = BTreeMap::new();
        let mut tick_interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(TICK_RATE)));
        let mut publish_interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(PUBLISH_RATE)));
        tick_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        publish_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = tick_interval.tick() => {
                    for elimination in world.tick() {
                        if let Some((sender, _)) = sessions.get(&elimination.player_id) {
                            let _ = sender.try_send(ServerMessage::Eliminated {
                                reason: elimination.reason,
                                final_worth_nanos: elimination.final_worth.0,
                                ticket_nanos: world.ticket().0,
                            });
                        }
                    }
                },
                _ = publish_interval.tick() => publish(&mut world, &delta_tx),
                command = command_rx.recv() => {
                    let Some(command) = command else { break };
                    match command {
                        WorldCommand::Join { name, skin, direct_tx, reply } => {
                            let id = world.join(name, skin);
                            publish(&mut world, &delta_tx);
                            sessions.insert(id, (direct_tx, false));
                            let _ = reply.send((id, world.bootstrap(id, "joined")));
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
                                if let Some((sender, _)) = sessions.get(&player_id) {
                                    let _ = sender.try_send(ServerMessage::Entered { ticket_nanos: world.ticket().0 });
                                }
                                publish(&mut world, &delta_tx);
                            }
                        }
                        WorldCommand::CashOut { player_id, replica } => {
                            check_replica(&world, player_id, replica, &mut sessions);
                            if let Some(receipt) = world.cash_out(player_id, ExitReason::CashOut) {
                                if let Some((sender, _)) = sessions.get(&player_id) {
                                    let _ = sender.try_send(ServerMessage::CashOutReceipt(receipt));
                                }
                                publish(&mut world, &delta_tx);
                            }
                        }
                        WorldCommand::Bootstrap { player_id, reason, reply } => {
                            let _ = reply.send(world.bootstrap(player_id, reason));
                        }
                        WorldCommand::Disconnect { player_id } => {
                            sessions.remove(&player_id);
                            if let Some(receipt) = world.disconnect(player_id) {
                                tracing::info!(
                                    receipt_id = receipt.id,
                                    player_id,
                                    payout_nanos = receipt.payout_nanos,
                                    "automatic disconnect cash-out"
                                );
                            }
                        }
                    }
                }
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
                text: Arc::from(text),
            });
        }
        Err(error) => tracing::error!(%error, "failed to serialize world delta"),
    }
}

fn check_replica(
    world: &GameWorld,
    player_id: EntityId,
    replica: Option<ReplicaState>,
    sessions: &mut BTreeMap<EntityId, (mpsc::Sender<ServerMessage>, bool)>,
) {
    let Some(ReplicaState { sequence, digest }) = replica else {
        return;
    };
    let matches = world.digest_matches(sequence, digest);
    let Some((sender, resync_pending)) = sessions.get_mut(&player_id) else {
        return;
    };
    if matches {
        *resync_pending = false;
    } else if !*resync_pending {
        let reason = if world.sequence_is_known(sequence) {
            "digestMismatch"
        } else {
            "sequenceUnknown"
        };
        if sender
            .try_send(ServerMessage::Bootstrap(world.bootstrap(player_id, reason)))
            .is_ok()
        {
            *resync_pending = true;
        }
    }
}
