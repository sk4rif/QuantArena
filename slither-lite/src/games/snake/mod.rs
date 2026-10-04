mod config;
mod digest;
mod game;
mod net;
mod protocol;

use std::net::SocketAddr;

use axum::{Json, Router, routing::get};
use net::session::{AppState, bot_ws_handler, ws_handler};

pub fn routes() -> (SocketAddr, Router) {
    let config = config::ServerConfig::from_env();
    let address = config.bind_address;
    tracing::info!(tier = config.tier.key(), ticket = %config.tier.ticket(), "snake economy configured");
    let public_config = serde_json::json!({
        "tier": config.tier.key(),
        "tierLabel": config.tier.label(),
        "ticketNanos": config.tier.ticket().0,
        "economyTickRate": config::TICK_RATE,
        "simulated": true,
    });
    let state = AppState {
        world: game::spawn_world(config.tier),
    };
    let routes = Router::new()
        .route(
            "/config",
            get(move || {
                let public_config = public_config.clone();
                async move { Json(public_config) }
            }),
        )
        .route("/ws", get(ws_handler))
        .route("/bot", get(bot_ws_handler))
        .with_state(state);
    (address, routes)
}
