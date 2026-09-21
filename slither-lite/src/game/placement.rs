use std::f32::consts::TAU;

use crate::config::ARENA_RADIUS;

use super::economy::{BALL, Money};

use super::entities::Vec2;

pub const PLACEMENT_VERSION: u16 = 3;
/// Floor balls scatter inside this radius around the spawn point so they do not stack exactly.
pub const SPAWN_SCATTER_RADIUS: f32 = 60.0;
/// The spawn search scans a `SPAWN_GRID` x `SPAWN_GRID` grid laid over the arena.
pub const SPAWN_GRID: usize = 64;
/// Softening added to squared distance so a snake's weight stays finite at its own position.
pub const SPAWN_WEIGHT_EPSILON: f64 = 100.0;
/// Spawn candidates and scattered balls stay inside this fraction of the arena radius.
pub const SPAWN_ARENA_FRACTION: f32 = 0.95;

#[derive(Debug, Clone, Copy)]
pub enum PlacementSource {
    Treasury = 1,
    Tax = 2,
    Rake = 3,
}

/// AUM weight of the map at `(x, y)`: every snake contributes `AUM_p / (distance^2 + epsilon)`.
pub fn aum_weight_at(x: f64, y: f64, stakes: &[(Vec2, Money)]) -> f64 {
    stakes
        .iter()
        .map(|(position, worth)| {
            let dx = x - f64::from(position.x);
            let dy = y - f64::from(position.y);
            worth.0 as f64 / (dx * dx + dy * dy + SPAWN_WEIGHT_EPSILON)
        })
        .sum()
}

/// The point of the arena with the lowest AUM weight, found by scanning a fixed grid row by row.
/// Ties go to the first cell scanned. Returns `None` when no snake holds any AUM.
pub fn spawn_point(stakes: impl IntoIterator<Item = (Vec2, Money)>) -> Option<Vec2> {
    let stakes = stakes.into_iter().collect::<Vec<_>>();
    if stakes.iter().all(|(_, worth)| worth.0 == 0) {
        return None;
    }
    let limit = f64::from(ARENA_RADIUS * SPAWN_ARENA_FRACTION);
    let cell = f64::from(ARENA_RADIUS) * 2.0 / SPAWN_GRID as f64;
    let mut best: Option<(f64, f64, f64)> = None;
    for row in 0..SPAWN_GRID {
        for column in 0..SPAWN_GRID {
            let x = -f64::from(ARENA_RADIUS) + (column as f64 + 0.5) * cell;
            let y = -f64::from(ARENA_RADIUS) + (row as f64 + 0.5) * cell;
            if x * x + y * y > limit * limit {
                continue;
            }
            let weight = aum_weight_at(x, y, &stakes);
            if best.is_none_or(|(lowest, _, _)| weight < lowest) {
                best = Some((weight, x, y));
            }
        }
    }
    best.map(|(_, x, y)| Vec2 {
        x: x as f32,
        y: y as f32,
    })
}

pub fn spawn_point_position(
    spawn: Vec2,
    seed: u64,
    tick: u64,
    source: PlacementSource,
    source_id: u64,
    ball_index: u64,
) -> Vec2 {
    let angle_hash = splitmix64(placement_base(seed, tick, source, source_id, ball_index));
    let radius_hash = splitmix64(angle_hash);
    let angle = unit_interval(angle_hash) * TAU;
    let radius = unit_interval(radius_hash).sqrt() * SPAWN_SCATTER_RADIUS;
    let limit = ARENA_RADIUS * SPAWN_ARENA_FRACTION;
    let x = spawn.x + angle.cos() * radius;
    let y = spawn.y + angle.sin() * radius;
    let distance = (x * x + y * y).sqrt();
    let scale = if distance > limit {
        limit / distance
    } else {
        1.0
    };
    Vec2 {
        x: x * scale,
        y: y * scale,
    }
}

fn placement_base(
    seed: u64,
    tick: u64,
    source: PlacementSource,
    source_id: u64,
    ball_index: u64,
) -> u64 {
    seed ^ tick.rotate_left(13)
        ^ (source as u64).rotate_left(29)
        ^ source_id.rotate_left(41)
        ^ ball_index.wrapping_mul(0x9e37_79b9_7f4a_7c15)
}

/// Fallback used when no snake holds any AUM (e.g. the initial treasury).
pub fn center_weighted_position(
    seed: u64,
    tick: u64,
    source: PlacementSource,
    source_id: u64,
    ball_index: u64,
) -> Vec2 {
    let angle_hash = splitmix64(placement_base(seed, tick, source, source_id, ball_index));
    let radius_hash = splitmix64(angle_hash);
    let angle = unit_interval(angle_hash) * TAU;
    let radius = unit_interval(radius_hash) * ARENA_RADIUS * 0.95;
    Vec2 {
        x: angle.cos() * radius,
        y: angle.sin() * radius,
    }
}

pub fn decompose_greedy(amount: Money) -> (Vec<Money>, Money) {
    let count = amount.0 / BALL.0;
    let residual = Money(amount.0 % BALL.0);
    (vec![BALL; count as usize], residual)
}

pub fn treasury_denominations(amount: Money) -> (Vec<Money>, Money) {
    decompose_greedy(amount)
}

pub fn deterministic_affordable_denomination(
    pool: Money,
    _seed: u64,
    _tick: u64,
    _ball_index: u64,
) -> Option<Money> {
    (pool >= BALL).then_some(BALL)
}

fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn unit_interval(value: u64) -> f32 {
    (value >> 40) as f32 / (1_u32 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::economy::Tier;

    #[test]
    fn treasury_represents_twenty_tickets_exactly() {
        for tier in [
            Tier::Paper,
            Tier::Casual,
            Tier::Mid,
            Tier::Standard,
            Tier::High,
            Tier::Elite,
        ] {
            let amount = tier.ticket().checked_mul(20);
            let (balls, residual) = treasury_denominations(amount);
            let represented = balls
                .iter()
                .fold(residual, |total, ball| total.checked_add(*ball));
            assert_eq!(represented, amount);
        }
    }

    fn stake(x: f32, y: f32, dollars: u64) -> (Vec2, Money) {
        (Vec2 { x, y }, Money::from_dollars(dollars))
    }

    #[test]
    fn spawn_point_is_the_lowest_aum_weight_in_the_arena() {
        let stakes = [stake(1_000.0, 0.0, 30), stake(0.0, 1_000.0, 10)];
        let spawn = spawn_point(stakes).unwrap();
        let weight = aum_weight_at(f64::from(spawn.x), f64::from(spawn.y), &stakes);
        // No other grid cell inside the arena is lighter than the chosen one.
        let cell = f64::from(ARENA_RADIUS) * 2.0 / SPAWN_GRID as f64;
        let limit = f64::from(ARENA_RADIUS * SPAWN_ARENA_FRACTION);
        for row in 0..SPAWN_GRID {
            for column in 0..SPAWN_GRID {
                let x = -f64::from(ARENA_RADIUS) + (column as f64 + 0.5) * cell;
                let y = -f64::from(ARENA_RADIUS) + (row as f64 + 0.5) * cell;
                if x * x + y * y <= limit * limit {
                    assert!(aum_weight_at(x, y, &stakes) >= weight);
                }
            }
        }
        // It lies on the far side of the arena from both snakes.
        assert!(spawn.x < 0.0 && spawn.y < 0.0);
    }

    #[test]
    fn heavier_snake_pushes_the_spawn_point_away() {
        let near_rich = spawn_point([stake(1_000.0, 0.0, 100), stake(-1_000.0, 0.0, 1)]).unwrap();
        let near_poor = spawn_point([stake(1_000.0, 0.0, 1), stake(-1_000.0, 0.0, 100)]).unwrap();
        assert!(near_rich.x < 0.0);
        assert!(near_poor.x > 0.0);
    }

    #[test]
    fn spawn_point_is_deterministic_and_inside_the_arena() {
        let stakes = [stake(200.0, -300.0, 5), stake(-2_000.0, 500.0, 50)];
        let first = spawn_point(stakes).unwrap();
        let second = spawn_point(stakes).unwrap();
        assert_eq!(first.x.to_bits(), second.x.to_bits());
        assert_eq!(first.y.to_bits(), second.y.to_bits());
        let radius = (first.x * first.x + first.y * first.y).sqrt();
        assert!(radius <= ARENA_RADIUS * SPAWN_ARENA_FRACTION);
    }

    #[test]
    fn spawn_point_requires_aum() {
        assert!(spawn_point([]).is_none());
        assert!(spawn_point([stake(5.0, 5.0, 0)]).is_none());
    }

    #[test]
    fn scattered_spawn_stays_near_point_and_inside_arena() {
        let spawn = Vec2 {
            x: -400.0,
            y: 300.0,
        };
        for index in 0..1_000 {
            let position = spawn_point_position(spawn, 7, 11, PlacementSource::Tax, 3, index);
            assert!(position.distance_squared(spawn).sqrt() <= SPAWN_SCATTER_RADIUS + 0.01);
        }
        let edge = Vec2 {
            x: ARENA_RADIUS * 0.95,
            y: 0.0,
        };
        let position = spawn_point_position(edge, 7, 11, PlacementSource::Tax, 3, 1);
        assert!(
            (position.x * position.x + position.y * position.y).sqrt()
                <= ARENA_RADIUS * 0.95 + 0.01
        );
    }

    #[test]
    fn placement_is_stable_and_center_weighted() {
        let first = center_weighted_position(7, 11, PlacementSource::Tax, 3, 5);
        let repeated = center_weighted_position(7, 11, PlacementSource::Tax, 3, 5);
        assert_eq!(first.x.to_bits(), repeated.x.to_bits());
        assert_eq!(first.y.to_bits(), repeated.y.to_bits());
        let average_radius = (0..10_000)
            .map(|index| center_weighted_position(7, 11, PlacementSource::Tax, 3, index))
            .map(|position| (position.x * position.x + position.y * position.y).sqrt())
            .sum::<f32>()
            / 10_000.0;
        assert!(average_radius < ARENA_RADIUS * 0.52);
    }
}
