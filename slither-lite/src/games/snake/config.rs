use std::{env, net::SocketAddr};

use super::game::economy::Tier;

pub const PROTOCOL_VERSION: u16 = 4;
pub const TICK_RATE: u16 = 30;
pub const PUBLISH_RATE: u16 = 15;
pub const ARENA_HALF_EXTENT: f32 = 3_000.0;
pub const ARENA_SIZE: f32 = ARENA_HALF_EXTENT * 2.0;
pub const BASE_SPEED: f32 = 150.0;
pub const BOOST_SPEED: f32 = 220.0;
pub const TURN_RATE: f32 = 3.4;
pub const BODY_SPACING: f32 = 10.0;
pub const DIGEST_HISTORY: usize = 256;
pub const POSITION_SCALE: f32 = 100.0;
pub const ANGLE_SCALE: f32 = 10_000.0;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind_address: SocketAddr,
    pub tier: Tier,
}

impl ServerConfig {
    pub fn from_env() -> Self {
        let bind_address = env::var("SLITHER_BIND")
            .unwrap_or_else(|_| "127.0.0.1:3001".to_owned())
            .parse()
            .expect("SLITHER_BIND must be a valid socket address");
        let tier = env::var("SLITHER_TIER")
            .unwrap_or_else(|_| "paper".to_owned())
            .parse()
            .expect("SLITHER_TIER must be paper, casual, mid, standard, high, or elite");
        Self { bind_address, tier }
    }
}
