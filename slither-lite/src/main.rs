mod games;

use axum::http::Method;
use axum::{Router, routing::get};
use tower_http::{
    cors::{Any, CorsLayer},
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

    let (address, snake_routes) = games::snake::routes();
    let static_files =
        ServeDir::new("web/dist").not_found_service(ServeFile::new("web/dist/index.html"));
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(snake_routes)
        .fallback_service(static_files)
        // The site measures ping to every region with `/health` and reads the chosen region's
        // `/config`, both cross-origin. They are public, read-only and credential-free, so any
        // origin may read them; sockets are gated separately by the WebSocket origin check.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET]),
        )
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind server");
    tracing::info!(%address, "Zero Sum server listening");
    axum::serve(listener, app).await.expect("server failed");
}
