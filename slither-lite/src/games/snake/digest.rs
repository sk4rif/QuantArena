use crate::games::snake::protocol::{EconomyStateWire, FoodWire, SnakeWire};

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

struct Hasher(u64);

impl Hasher {
    fn new() -> Self {
        Self(FNV_OFFSET)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(FNV_PRIME);
        }
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn i32(&mut self, value: i32) {
        self.bytes(&value.to_le_bytes());
    }

    fn string(&mut self, value: &str) {
        self.u32(value.len() as u32);
        self.bytes(value.as_bytes());
    }
}

pub fn state_digest(snakes: &[SnakeWire], food: &[FoodWire], economy: EconomyStateWire) -> u64 {
    let mut snakes = snakes.iter().collect::<Vec<_>>();
    snakes.sort_unstable_by_key(|snake| snake.id);
    let mut food = food.iter().collect::<Vec<_>>();
    food.sort_unstable_by_key(|item| item.id);

    let mut hash = Hasher::new();
    hash.bytes(b"SLITHER2");
    hash.u64(economy.pending_floor_nanos);
    hash.u64(economy.ticket_inflow_nanos);
    hash.u64(economy.payouts_nanos);
    hash.u64(economy.platform_fees_nanos);
    hash.u32(snakes.len() as u32);
    for snake in snakes {
        hash.u8(1);
        hash.u32(snake.id);
        hash.string(&snake.name);
        hash.string(&snake.skin);
        hash.i32(snake.x);
        hash.i32(snake.y);
        hash.i32(snake.angle);
        hash.i32(snake.speed);
        hash.i32(snake.radius);
        hash.u64(snake.worth_nanos);
        hash.u32(snake.last_input_seq);
        hash.u32(snake.body.len() as u32);
        for point in &snake.body {
            hash.u64(point.id);
            hash.i32(point.x);
            hash.i32(point.y);
        }
    }
    hash.u32(food.len() as u32);
    for item in food {
        hash.u8(2);
        hash.u32(item.id);
        hash.i32(item.x);
        hash.i32(item.y);
        hash.i32(item.radius);
        hash.u64(item.value_nanos);
        hash.u8(item.color);
    }
    hash.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::snake::protocol::BodyPointWire;

    #[test]
    fn digest_is_stable_regardless_of_entity_order() {
        let snake = SnakeWire {
            id: 7,
            name: "Ada".into(),
            skin: "red".into(),
            x: 100,
            y: -50,
            angle: 10,
            speed: 15_000,
            radius: 1_200,
            worth_nanos: 5_125_000_000,
            last_input_seq: 2,
            body: vec![BodyPointWire {
                id: 9,
                x: 80,
                y: -50,
            }],
        };
        let first = FoodWire {
            id: 2,
            x: 0,
            y: 1,
            radius: 300,
            value_nanos: 5_000_000,
            color: 1,
        };
        let second = FoodWire {
            id: 1,
            x: 2,
            y: 3,
            radius: 300,
            value_nanos: 10_000_000,
            color: 2,
        };
        let economy = EconomyStateWire {
            pending_floor_nanos: 1,
            ticket_inflow_nanos: 5_000_000_000,
            payouts_nanos: 0,
            platform_fees_nanos: 0,
        };
        let digest = state_digest(std::slice::from_ref(&snake), &[first, second], economy);
        assert_eq!(digest, 0x748a_7b25_5b04_9176);
        assert_eq!(digest, state_digest(&[snake], &[second, first], economy));
    }
}
