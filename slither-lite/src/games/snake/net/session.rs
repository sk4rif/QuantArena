use std::time::{Duration, Instant};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{
        HeaderMap, StatusCode,
        header::{HOST, ORIGIN},
    },
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};

use crate::games::snake::{
    config::PROTOCOL_VERSION,
    game::{ReplicaState, WorldCommand, WorldHandle},
    protocol::{
        Bootstrap, BotMessage, ClientMessage, ServerMessage, aim_from_vector, digest_from_hex,
    },
};

/// Which endpoint a socket connected through. Both receive identical server
/// messages; they differ only in the client messages they accept.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Endpoint {
    Browser,
    Bot,
}

#[derive(Clone)]
pub struct AppState {
    pub world: WorldHandle,
}

pub async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    ws.max_message_size(8 * 1024)
        .max_frame_size(8 * 1024)
        .on_upgrade(move |socket| serve_socket(socket, state.world, Endpoint::Browser))
}

pub async fn bot_ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    ws.max_message_size(8 * 1024)
        .max_frame_size(8 * 1024)
        .on_upgrade(move |socket| serve_socket(socket, state.world, Endpoint::Bot))
}

async fn serve_socket(socket: WebSocket, world: WorldHandle, endpoint: Endpoint) {
    let mut deltas = world.subscribe();
    let (mut sender, mut receiver) = socket.split();
    let first = tokio::time::timeout(Duration::from_secs(8), receiver.next()).await;
    let Some(Ok(Message::Text(text))) = first.ok().flatten() else {
        let _ = send_error(&mut sender, "joinRequired", "first message must be join").await;
        return;
    };
    let Some((protocol, name, skin, spectate)) = parse_join(endpoint, &text) else {
        let _ = send_error(
            &mut sender,
            "joinRequired",
            "first message must be a valid join",
        )
        .await;
        return;
    };
    if protocol != PROTOCOL_VERSION {
        let _ = send_error(
            &mut sender,
            "protocolMismatch",
            "unsupported protocol version",
        )
        .await;
        return;
    }
    let Some(name) = sanitize_name(&name) else {
        let _ = send_error(
            &mut sender,
            "invalidName",
            "name must contain 1-20 safe characters",
        )
        .await;
        return;
    };
    if !valid_skin(&skin) {
        let _ = send_error(&mut sender, "invalidSkin", "unknown skin").await;
        return;
    }

    let (direct_tx, mut direct_rx) = mpsc::channel(8);
    let (reply_tx, reply_rx) = oneshot::channel();
    if world
        .commands
        .send(WorldCommand::Join {
            name,
            skin,
            spectate,
            direct_tx,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        let _ = send_error(
            &mut sender,
            "serverUnavailable",
            "game world is unavailable",
        )
        .await;
        return;
    }
    let Ok((player_id, bootstrap)) = reply_rx.await else {
        return;
    };
    let mut last_sent_sequence = bootstrap.sequence;
    let mut last_client_resync = Instant::now() - Duration::from_secs(2);
    let mut next_input_seq: u32 = 0;
    if send_server(&mut sender, ServerMessage::Bootstrap(bootstrap))
        .await
        .is_err()
    {
        disconnect(&world, player_id).await;
        return;
    }

    loop {
        tokio::select! {
            biased;
            direct = direct_rx.recv() => {
                let Some(direct) = direct else { break };
                if let ServerMessage::Bootstrap(bootstrap) = &direct {
                    last_sent_sequence = bootstrap.sequence;
                }
                if send_server(&mut sender, direct).await.is_err() {
                    break;
                }
            }
            delta = deltas.recv() => {
                match delta {
                    Ok(delta) if delta.sequence > last_sent_sequence => {
                        last_sent_sequence = delta.sequence;
                        if sender.send(Message::Text(delta.text.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(bootstrap) = request_bootstrap(&world, player_id, "queueOverflow").await {
                            last_sent_sequence = bootstrap.sequence;
                            if send_server(&mut sender, ServerMessage::Bootstrap(bootstrap)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break };
                match message {
                    Message::Text(text) => {
                        let keep_open = match endpoint {
                            Endpoint::Browser => {
                                handle_client_message(
                                    &world,
                                    player_id,
                                    &mut sender,
                                    &text,
                                    &mut last_client_resync,
                                ).await
                            }
                            Endpoint::Bot => {
                                handle_bot_message(
                                    &world,
                                    player_id,
                                    &mut sender,
                                    &text,
                                    &mut last_client_resync,
                                    &mut next_input_seq,
                                ).await
                            }
                        };
                        if !keep_open {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Message::Binary(_) | Message::Pong(_) => {}
                }
            }
        }
    }
    disconnect(&world, player_id).await;
}

async fn handle_client_message<S>(
    world: &WorldHandle,
    player_id: u32,
    sender: &mut S,
    text: &str,
    last_client_resync: &mut Instant,
) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    let message = match serde_json::from_str::<ClientMessage>(text) {
        Ok(message) => message,
        Err(_) => {
            let _ = send_error(sender, "invalidMessage", "message does not match protocol").await;
            return true;
        }
    };
    let command = match message {
        ClientMessage::Input {
            input_seq,
            aim,
            boost,
            state_sequence,
            state_digest,
        } => {
            let Some(state_digest) = digest_from_hex(&state_digest) else {
                let _ = send_error(
                    sender,
                    "invalidDigest",
                    "digest must be 16 lowercase hex characters",
                )
                .await;
                return true;
            };
            if !aim.is_finite() {
                let _ = send_error(sender, "invalidAim", "aim must be finite").await;
                return true;
            }
            WorldCommand::Input {
                player_id,
                input_seq,
                aim,
                boosting: boost,
                replica: Some(ReplicaState {
                    sequence: state_sequence,
                    digest: state_digest,
                }),
            }
        }
        ClientMessage::Reenter {
            state_sequence,
            state_digest,
        } => {
            let Some(state_digest) = digest_from_hex(&state_digest) else {
                let _ =
                    send_error(sender, "invalidDigest", "digest must be 16 hex characters").await;
                return true;
            };
            WorldCommand::Reenter {
                player_id,
                replica: Some(ReplicaState {
                    sequence: state_sequence,
                    digest: state_digest,
                }),
            }
        }
        ClientMessage::CashOut {
            state_sequence,
            state_digest,
        } => {
            let Some(state_digest) = digest_from_hex(&state_digest) else {
                let _ =
                    send_error(sender, "invalidDigest", "digest must be 16 hex characters").await;
                return true;
            };
            WorldCommand::CashOut {
                player_id,
                replica: Some(ReplicaState {
                    sequence: state_sequence,
                    digest: state_digest,
                }),
            }
        }
        ClientMessage::CancelCashOut {
            state_sequence,
            state_digest,
        } => {
            let Some(state_digest) = digest_from_hex(&state_digest) else {
                let _ =
                    send_error(sender, "invalidDigest", "digest must be 16 hex characters").await;
                return true;
            };
            WorldCommand::CancelCashOut {
                player_id,
                replica: Some(ReplicaState {
                    sequence: state_sequence,
                    digest: state_digest,
                }),
            }
        }
        ClientMessage::Resync {
            state_sequence,
            state_digest,
            reason,
        } => {
            if digest_from_hex(&state_digest).is_none() {
                let _ =
                    send_error(sender, "invalidDigest", "digest must be 16 hex characters").await;
                return true;
            }
            tracing::debug!(player_id, state_sequence, %reason, "client requested state resync");
            let reason = match reason.as_str() {
                "sequenceGap" => "clientSequenceGap",
                "digestMismatch" => "clientDigestMismatch",
                _ => "clientRequested",
            };
            return resync(world, player_id, sender, reason, last_client_resync).await;
        }
        ClientMessage::Ping { sent_at } => {
            return send_server(sender, ServerMessage::Pong { sent_at })
                .await
                .is_ok();
        }
        ClientMessage::Join { .. } => {
            let _ = send_error(sender, "alreadyJoined", "join may only be sent once").await;
            return true;
        }
    };
    world.commands.send(command).await.is_ok()
}

async fn handle_bot_message<S>(
    world: &WorldHandle,
    player_id: u32,
    sender: &mut S,
    text: &str,
    last_client_resync: &mut Instant,
    next_input_seq: &mut u32,
) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    let Ok(message) = serde_json::from_str::<BotMessage>(text) else {
        let _ = send_error(
            sender,
            "invalidMessage",
            "message does not match bot protocol",
        )
        .await;
        return true;
    };
    let command = match message {
        BotMessage::Input { y, x, boost } => {
            let Some(aim) = aim_from_vector(y, x) else {
                let _ = send_error(
                    sender,
                    "invalidVector",
                    "input vector must be finite and non-zero",
                )
                .await;
                return true;
            };
            *next_input_seq = next_input_seq.wrapping_add(1);
            WorldCommand::Input {
                player_id,
                input_seq: *next_input_seq,
                aim,
                boosting: boost,
                replica: None,
            }
        }
        BotMessage::Reenter => WorldCommand::Reenter {
            player_id,
            replica: None,
        },
        BotMessage::CashOut => WorldCommand::CashOut {
            player_id,
            replica: None,
        },
        BotMessage::CancelCashOut => WorldCommand::CancelCashOut {
            player_id,
            replica: None,
        },
        BotMessage::Resync => {
            return resync(
                world,
                player_id,
                sender,
                "clientRequested",
                last_client_resync,
            )
            .await;
        }
        BotMessage::Ping { sent_at } => {
            return send_server(sender, ServerMessage::Pong { sent_at })
                .await
                .is_ok();
        }
        BotMessage::Join { .. } => {
            let _ = send_error(sender, "alreadyJoined", "join may only be sent once").await;
            return true;
        }
    };
    world.commands.send(command).await.is_ok()
}

/// Sends a fresh bootstrap, rate limited to one per second per connection.
async fn resync<S>(
    world: &WorldHandle,
    player_id: u32,
    sender: &mut S,
    reason: &str,
    last_client_resync: &mut Instant,
) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    if last_client_resync.elapsed() < Duration::from_secs(1) {
        return true;
    }
    *last_client_resync = Instant::now();
    let Some(bootstrap) = request_bootstrap(world, player_id, reason).await else {
        return false;
    };
    send_server(sender, ServerMessage::Bootstrap(bootstrap))
        .await
        .is_ok()
}

fn parse_join(endpoint: Endpoint, text: &str) -> Option<(u16, String, String, bool)> {
    match endpoint {
        Endpoint::Browser => match serde_json::from_str(text).ok()? {
            ClientMessage::Join {
                protocol,
                name,
                skin,
                spectate,
            } => Some((protocol, name, skin, spectate)),
            _ => None,
        },
        Endpoint::Bot => match serde_json::from_str(text).ok()? {
            BotMessage::Join {
                protocol,
                name,
                skin,
            } => Some((
                protocol,
                name,
                skin.unwrap_or_else(|| "blue".to_owned()),
                false,
            )),
            _ => None,
        },
    }
}

async fn request_bootstrap(world: &WorldHandle, player_id: u32, reason: &str) -> Option<Bootstrap> {
    let (reply, response) = oneshot::channel();
    world
        .commands
        .send(WorldCommand::Bootstrap {
            player_id,
            reason: reason.to_owned(),
            reply,
        })
        .await
        .ok()?;
    response.await.ok()
}

async fn disconnect(world: &WorldHandle, player_id: u32) {
    let _ = world
        .commands
        .send(WorldCommand::Disconnect { player_id })
        .await;
}

async fn send_server<S>(sender: &mut S, message: ServerMessage) -> Result<(), S::Error>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let text = serde_json::to_string(&message).expect("server messages must serialize");
    sender.send(Message::Text(text.into())).await
}

async fn send_error<S>(sender: &mut S, code: &str, message: &str) -> Result<(), S::Error>
where
    S: futures_util::Sink<Message> + Unpin,
{
    send_server(
        sender,
        ServerMessage::Error {
            code: code.to_owned(),
            message: message.to_owned(),
        },
    )
    .await
}

fn sanitize_name(value: &str) -> Option<String> {
    let name = value.trim();
    (!name.is_empty()
        && name.chars().count() <= 20
        && name
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, ' ' | '_' | '-')))
    .then(|| name.to_owned())
}

fn valid_skin(value: &str) -> bool {
    matches!(
        value,
        "red" | "blue" | "green" | "purple" | "orange" | "yellow"
    )
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    origin == format!("http://{host}")
        || origin == format!("https://{host}")
        || origin.starts_with("http://localhost:")
        || origin.starts_with("http://127.0.0.1:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_distinguish_browser_spectators_from_bots() {
        let bot_join = r#"{"type":"join","protocol":4,"name":"alpha"}"#;
        assert_eq!(
            parse_join(Endpoint::Bot, bot_join),
            Some((4, "alpha".to_owned(), "blue".to_owned(), false))
        );
        assert_eq!(parse_join(Endpoint::Browser, bot_join), None);

        let player_join = r#"{"type":"join","protocol":4,"name":"alpha","skin":"red"}"#;
        assert_eq!(
            parse_join(Endpoint::Browser, player_join),
            Some((4, "alpha".to_owned(), "red".to_owned(), false))
        );
        let spectator_join =
            r#"{"type":"join","protocol":4,"name":"alpha","skin":"red","spectate":true}"#;
        assert_eq!(
            parse_join(Endpoint::Browser, spectator_join),
            Some((4, "alpha".to_owned(), "red".to_owned(), true))
        );
        assert_eq!(
            parse_join(Endpoint::Bot, r#"{"type":"input","y":1,"x":1}"#),
            None
        );
    }

    #[test]
    fn sanitizes_safe_names() {
        assert_eq!(sanitize_name("  Ada-1  ").as_deref(), Some("Ada-1"));
        assert!(sanitize_name("").is_none());
        assert!(sanitize_name("<script>").is_none());
    }
}
