mod config;
mod digest;
mod game;
mod net;
mod protocol;

use axum::{Json, Router, routing::get};
use net::session::{AppState, bot_ws_handler, ws_handler};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "slither_lite=info,tower_http=info".into()),
        )
        .init();

    let config = config::ServerConfig::from_env();
    let address = config.bind_address;
    tracing::info!(tier = config.tier.key(), ticket = %config.tier.ticket(), "economy configured");
    let public_config = serde_json::json!({
        "tier": config.tier.key(),
        "tierLabel": config.tier.label(),
        "ticketNanos": config.tier.ticket().0,
        "economyTickRate": config::TICK_RATE,
        "simulated": true,
    });
    let state = AppState {
        world: game::spawn_world(config.tier, config.placement_seed),
    };
    let static_files =
        ServeDir::new("web/dist").not_found_service(ServeFile::new("web/dist/index.html"));
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/config",
            get(move || {
                let public_config = public_config.clone();
                async move { Json(public_config) }
            }),
        )
        .route("/ws", get(ws_handler))
        .route("/bot", get(bot_ws_handler))
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind server");
    tracing::info!(%address, "slither-lite server listening");
    axum::serve(listener, app).await.expect("server failed");
}
