use std::collections::VecDeque;

use crate::games::snake::{
    config::{ARENA_HALF_EXTENT, ARENA_SIZE, POSITION_SCALE},
    protocol::{
        BodyPointWire, EntityId, FoodWire, SampleId, SnakeWire, quantize_angle, quantize_position,
    },
};

use super::economy::{BALL, FormulaRemainder, Money};

#[derive(Debug, Clone, Copy, Default)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub fn distance_squared(self, other: Self) -> f32 {
        let dx = wrapped_delta(self.x - other.x);
        let dy = wrapped_delta(self.y - other.y);
        dx * dx + dy * dy
    }

    pub fn wrapped(self) -> Self {
        Self {
            x: wrap_coordinate(self.x),
            y: wrap_coordinate(self.y),
        }
    }
}

fn wrapped_delta(value: f32) -> f32 {
    wrap_coordinate(value)
}

fn wrap_coordinate(value: f32) -> f32 {
    (value + ARENA_HALF_EXTENT).rem_euclid(ARENA_SIZE) - ARENA_HALF_EXTENT
}

#[derive(Debug, Clone, Copy)]
pub struct BodyPoint {
    pub id: SampleId,
    pub position: Vec2,
}

#[derive(Debug, Clone)]
pub struct Snake {
    pub id: EntityId,
    pub name: String,
    pub skin: String,
    pub position: Vec2,
    pub angle: f32,
    pub aim: f32,
    pub boosting: bool,
    pub speed: f32,
    pub worth: Money,
    pub last_input_seq: u32,
    pub body: VecDeque<BodyPoint>,
    pub invulnerable_ticks: u16,
    pub tax_remainder: FormulaRemainder,
    pub boost_remainder: FormulaRemainder,
}

impl Snake {
    pub fn radius(&self, ticket: Money) -> f32 {
        let ratio = self.worth.0 as f64 / ticket.0 as f64;
        (12.0 * ratio.sqrt() as f32).clamp(10.0, 48.0)
    }

    pub fn desired_body_points(&self, ticket: Money) -> usize {
        let ratio = self.worth.0 as f64 / ticket.0 as f64;
        (24.0 * ratio).round().clamp(8.0, 1_200.0) as usize
    }

    pub fn to_wire(&self, ticket: Money) -> SnakeWire {
        SnakeWire {
            id: self.id,
            name: self.name.clone(),
            skin: self.skin.clone(),
            x: quantize_position(self.position.x),
            y: quantize_position(self.position.y),
            angle: quantize_angle(self.angle),
            speed: quantize_position(self.speed),
            radius: quantize_position(self.radius(ticket)),
            worth_nanos: self.worth.0,
            last_input_seq: self.last_input_seq,
            body: self.body.iter().copied().map(BodyPoint::to_wire).collect(),
        }
    }
}

impl BodyPoint {
    pub fn to_wire(self) -> BodyPointWire {
        BodyPointWire {
            id: self.id,
            x: (self.position.x * POSITION_SCALE).round() as i32,
            y: (self.position.y * POSITION_SCALE).round() as i32,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Food {
    pub id: EntityId,
    pub position: Vec2,
    pub value: Money,
    pub color: u8,
}

impl Food {
    pub fn radius(self) -> f32 {
        let multiple = self.value.0 as f32 / BALL.0 as f32;
        4.0 + 2.0 * (multiple + 1.0).log2()
    }

    pub fn to_wire(self) -> FoodWire {
        FoodWire {
            id: self.id,
            x: quantize_position(self.position.x),
            y: quantize_position(self.position.y),
            radius: quantize_position(self.radius()),
            value_nanos: self.value.0,
            color: self.color,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::snake::game::economy::Tier;

    fn snake(worth: Money) -> Snake {
        Snake {
            id: 1,
            name: "Test".into(),
            skin: "red".into(),
            position: Vec2::default(),
            angle: 0.0,
            aim: 0.0,
            boosting: false,
            speed: 0.0,
            worth,
            last_input_seq: 0,
            body: VecDeque::new(),
            invulnerable_ticks: 0,
            tax_remainder: FormulaRemainder::default(),
            boost_remainder: FormulaRemainder::default(),
        }
    }

    #[test]
    fn positions_wrap_and_use_the_shortest_toroidal_distance() {
        let wrapped = Vec2 {
            x: ARENA_HALF_EXTENT + 4.0,
            y: -ARENA_HALF_EXTENT - 7.0,
        }
        .wrapped();
        assert_eq!(wrapped.x, -ARENA_HALF_EXTENT + 4.0);
        assert_eq!(wrapped.y, ARENA_HALF_EXTENT - 7.0);
        assert_eq!(
            Vec2 {
                x: ARENA_HALF_EXTENT - 3.0,
                y: 0.0,
            }
            .distance_squared(Vec2 {
                x: -ARENA_HALF_EXTENT + 2.0,
                y: 0.0,
            }),
            25.0
        );
    }

    #[test]
    fn every_tier_starts_with_same_geometry() {
        for tier in [
            Tier::Paper,
            Tier::Casual,
            Tier::Mid,
            Tier::Standard,
            Tier::High,
            Tier::Elite,
        ] {
            let snake = snake(tier.ticket());
            assert_eq!(snake.radius(tier.ticket()), 12.0);
            assert_eq!(snake.desired_body_points(tier.ticket()), 24);
        }
    }

    #[test]
    fn doubling_worth_visibly_changes_girth_and_length() {
        let ticket = Tier::Casual.ticket();
        let snake = snake(ticket.checked_mul(2));
        assert!((snake.radius(ticket) - 12.0 * 2.0_f32.sqrt()).abs() < 0.001);
        assert_eq!(snake.desired_body_points(ticket), 48);
    }
}
