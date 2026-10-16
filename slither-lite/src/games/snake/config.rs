use std::{env, net::SocketAddr};

use super::game::economy::Tier;

pub const PROTOCOL_VERSION: u16 = 5;
pub const TICK_RATE: u16 = 30;
pub const PUBLISH_RATE: u16 = 15;
pub const ARENA_HALF_EXTENT: f32 = 3_000.0;
pub const ARENA_SIZE: f32 = ARENA_HALF_EXTENT * 2.0;
pub const BASE_SPEED: f32 = 150.0;
pub const BOOST_SPEED: f32 = 440.0;
pub const TURN_RATE: f32 = 3.4;
pub const BODY_SPACING: f32 = 10.0;
/// Fraction of the gap to the newer point that an older body point closes when a sample is laid
/// down. The first four points behind the rigid neck ramp up to this value. This is slither.io's `cst`.
pub const BODY_PULL: f32 = 0.43;
pub const DIGEST_HISTORY: usize = 256;
pub const POSITION_SCALE: f32 = 100.0;
pub const ANGLE_SCALE: f32 = 10_000.0;

/// Region key reported when `SLITHER_REGION` is not set, e.g. on a developer machine.
pub const DEFAULT_REGION: &str = "local";

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind_address: SocketAddr,
    pub tier: Tier,
    /// Short region key (e.g. `us-east`) reported by `/config`, so the browser can confirm it
    /// reached the region it chose. Every region runs its own, independent arena.
    pub region: String,
    /// Extra browser origins (besides this server's own host and localhost) whose pages may
    /// open `/ws` and `/bot`. Set this to the site's origin when the site is served from a
    /// different host than this arena, which is the case for every region but one.
    pub allowed_origins: Vec<String>,
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
        let region = parse_region(&env::var("SLITHER_REGION").unwrap_or_default()).expect(
            "SLITHER_REGION must be 1-32 lowercase letters, digits or hyphens (e.g. us-east)",
        );
        let allowed_origins =
            parse_allowed_origins(&env::var("SLITHER_ALLOWED_ORIGINS").unwrap_or_default());
        Self {
            bind_address,
            tier,
            region,
            allowed_origins,
        }
    }
}

/// An empty value means the default region; anything else must be a short lowercase slug.
pub fn parse_region(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return Some(DEFAULT_REGION.to_owned());
    }
    let valid = value.len() <= 32
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    valid.then(|| value.to_owned())
}

/// Comma-separated origins such as `https://play.example.com, https://example.com/`.
/// Entries are trimmed and lose any trailing slash, because browsers send origins without one.
pub fn parse_allowed_origins(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|origin| origin.trim().trim_end_matches('/'))
        .filter(|origin| !origin.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regions_default_to_local_and_reject_unsafe_keys() {
        assert_eq!(parse_region("").as_deref(), Some("local"));
        assert_eq!(parse_region("  us-east ").as_deref(), Some("us-east"));
        assert_eq!(
            parse_region("ap-southeast-1").as_deref(),
            Some("ap-southeast-1")
        );
        assert_eq!(parse_region("US-East"), None);
        assert_eq!(parse_region("eu west"), None);
        assert_eq!(parse_region(&"a".repeat(33)), None);
    }

    #[test]
    fn allowed_origins_are_trimmed_and_normalised() {
        assert_eq!(
            parse_allowed_origins(" https://play.example.com/ ,https://example.com,, "),
            vec!["https://play.example.com", "https://example.com"]
        );
        assert!(parse_allowed_origins("").is_empty());
    }
}
