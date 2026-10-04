mod games;

use axum::{Router, routing::get};
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

    let (address, snake_routes) = games::snake::routes();
    let static_files =
        ServeDir::new("web/dist").not_found_service(ServeFile::new("web/dist/index.html"));
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(snake_routes)
        .fallback_service(static_files)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind server");
    tracing::info!(%address, "Zero Sum server listening");
    axum::serve(listener, app).await.expect("server failed");
}
