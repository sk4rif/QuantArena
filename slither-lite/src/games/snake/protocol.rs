use serde::{Deserialize, Serialize};

use super::{
    config::{ANGLE_SCALE, POSITION_SCALE},
    game::economy::Receipt,
};

pub type EntityId = u32;
pub type SampleId = u64;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Join {
        protocol: u16,
        name: String,
        skin: String,
        #[serde(default)]
        spectate: bool,
    },
    Input {
        #[serde(rename = "inputSeq")]
        input_seq: u32,
        aim: f32,
        boost: bool,
        #[serde(rename = "stateSequence")]
        state_sequence: u64,
        #[serde(rename = "stateDigest")]
        state_digest: String,
    },
    Reenter {
        #[serde(rename = "stateSequence")]
        state_sequence: u64,
        #[serde(rename = "stateDigest")]
        state_digest: String,
    },
    CashOut {
        #[serde(rename = "stateSequence")]
        state_sequence: u64,
        #[serde(rename = "stateDigest")]
        state_digest: String,
    },
    CancelCashOut {
        #[serde(rename = "stateSequence")]
        state_sequence: u64,
        #[serde(rename = "stateDigest")]
        state_digest: String,
    },
    Resync {
        #[serde(rename = "stateSequence")]
        state_sequence: u64,
        #[serde(rename = "stateDigest")]
        state_digest: String,
        reason: String,
    },
    Ping {
        #[serde(rename = "sentAt")]
        sent_at: u64,
    },
}

/// Messages accepted on the `/bot` endpoint. Server output is identical to the
/// browser endpoint; only the input side is simplified (no replica digests).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BotMessage {
    Join {
        protocol: u16,
        name: String,
        skin: Option<String>,
    },
    /// Steering direction in world axes (`y` grows downward). Any non-zero
    /// magnitude is accepted; only the direction matters.
    Input {
        y: f32,
        x: f32,
        #[serde(default)]
        boost: bool,
    },
    Reenter,
    CashOut,
    CancelCashOut,
    Resync,
    Ping {
        #[serde(rename = "sentAt")]
        sent_at: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Bootstrap(Bootstrap),
    Delta(Delta),
    Entered {
        #[serde(rename = "ticketNanos")]
        ticket_nanos: u64,
    },
    Eliminated {
        reason: String,
        #[serde(rename = "finalWorthNanos")]
        final_worth_nanos: u64,
        #[serde(rename = "ticketNanos")]
        ticket_nanos: u64,
    },
    CashOutPending {
        #[serde(rename = "completesAtTick")]
        completes_at_tick: u64,
    },
    CashOutCanceled,
    CashOutReceipt(Receipt),
    Pong {
        #[serde(rename = "sentAt")]
        sent_at: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub protocol: u16,
    pub player_id: EntityId,
    pub tick_rate: u16,
    pub publish_rate: u16,
    pub arena_half_extent: i32,
    pub cash_out_completes_at_tick: Option<u64>,
    pub tick: u64,
    pub sequence: u64,
    pub digest: String,
    pub reason: String,
    pub economy_config: EconomyConfigWire,
    pub economy: EconomyStateWire,
    pub snakes: Vec<SnakeWire>,
    pub food: Vec<FoodWire>,
    pub leaderboard: Vec<LeaderboardEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub tick: u64,
    pub sequence: u64,
    pub digest: String,
    pub economy: EconomyStateWire,
    pub snakes_added: Vec<SnakeWire>,
    pub snakes_updated: Vec<SnakePatch>,
    pub snakes_removed: Vec<EntityId>,
    pub food_added: Vec<FoodWire>,
    pub food_removed: Vec<EntityId>,
    pub leaderboard: Vec<LeaderboardEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EconomyConfigWire {
    pub tier: String,
    pub tier_label: String,
    pub ticket_nanos: u64,
    pub denominations_nanos: Vec<u64>,
    pub economy_tick_rate: u16,
    pub treasury_seed_nanos: u64,
    pub minimum_effective_worth_nanos: u64,
    pub tax_numerator: u64,
    pub tax_denominator: u64,
    pub boost_numerator: u64,
    pub boost_denominator: u64,
    pub cash_out_delay_ticks: u64,
    pub payout_basis_points: u16,
    pub platform_fee_basis_points: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EconomyStateWire {
    pub pending_floor_nanos: u64,
    pub ticket_inflow_nanos: u64,
    pub payouts_nanos: u64,
    pub platform_fees_nanos: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnakeWire {
    pub id: EntityId,
    pub name: String,
    pub skin: String,
    pub x: i32,
    pub y: i32,
    pub angle: i32,
    pub speed: i32,
    pub radius: i32,
    pub worth_nanos: u64,
    pub last_input_seq: u32,
    pub body: Vec<BodyPointWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnakePatch {
    pub id: EntityId,
    pub x: i32,
    pub y: i32,
    pub angle: i32,
    pub speed: i32,
    pub radius: i32,
    pub worth_nanos: u64,
    pub last_input_seq: u32,
    pub trim_body: usize,
    pub append_body: Vec<BodyPointWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace_body: Option<Vec<BodyPointWire>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyPointWire {
    pub id: SampleId,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodWire {
    pub id: EntityId,
    pub x: i32,
    pub y: i32,
    pub radius: i32,
    pub value_nanos: u64,
    pub color: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    pub id: EntityId,
    pub name: String,
    pub worth_nanos: u64,
}

/// Converts a steering vector into the aim angle used by the simulation
/// (`x = cos(aim)`, `y = sin(aim)`). Returns `None` for zero or non-finite vectors.
pub fn aim_from_vector(y: f32, x: f32) -> Option<f32> {
    (x.is_finite() && y.is_finite() && (x != 0.0 || y != 0.0)).then(|| y.atan2(x))
}

pub fn quantize_position(value: f32) -> i32 {
    (value * POSITION_SCALE).round() as i32
}

pub fn quantize_angle(value: f32) -> i32 {
    (value * ANGLE_SCALE).round() as i32
}

pub fn digest_to_hex(digest: u64) -> String {
    format!("{digest:016x}")
}

pub fn digest_from_hex(value: &str) -> Option<u64> {
    (value.len() == 16)
        .then(|| u64::from_str_radix(value, 16).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_maps_to_simulation_aim() {
        assert_eq!(aim_from_vector(0.0, 5.0), Some(0.0));
        assert!((aim_from_vector(3.0, 0.0).unwrap() - std::f32::consts::FRAC_PI_2).abs() < 1e-6);
        assert!((aim_from_vector(0.0, -1.0).unwrap() - std::f32::consts::PI).abs() < 1e-6);
        assert_eq!(aim_from_vector(0.0, 0.0), None);
        assert_eq!(aim_from_vector(f32::NAN, 1.0), None);
        assert_eq!(aim_from_vector(1.0, f32::INFINITY), None);
    }

    #[test]
    fn bot_messages_parse_without_digests() {
        let input: BotMessage =
            serde_json::from_str(r#"{"type":"input","y":-1,"x":0.5,"boost":true}"#).unwrap();
        assert!(matches!(input, BotMessage::Input { boost: true, .. }));
        let input: BotMessage = serde_json::from_str(r#"{"type":"input","y":1,"x":0}"#).unwrap();
        assert!(matches!(input, BotMessage::Input { boost: false, .. }));
        assert!(matches!(
            serde_json::from_str::<BotMessage>(r#"{"type":"cashOut"}"#).unwrap(),
            BotMessage::CashOut
        ));
        assert!(matches!(
            serde_json::from_str::<BotMessage>(r#"{"type":"cancelCashOut"}"#).unwrap(),
            BotMessage::CancelCashOut
        ));
        assert!(serde_json::from_str::<BotMessage>(r#"{"type":"input","x":1}"#).is_err());
    }

    #[test]
    fn digest_requires_exactly_eight_bytes_of_hex() {
        assert_eq!(
            digest_from_hex("8a41d9c722ad30f1"),
            Some(0x8a41_d9c7_22ad_30f1)
        );
        assert_eq!(digest_from_hex("1234"), None);
        assert_eq!(digest_from_hex("not-a-valid-hash"), None);
    }
}
