use crate::games::snake::config::{ARENA_HALF_EXTENT, ARENA_SIZE};

use super::economy::{BALL, Money};

use super::entities::Vec2;

pub const TREASURY_GRID_SPACING: f32 = 50.0;
pub const TREASURY_BALLS_PER_POINT: usize = 2;
/// The spawn search scans a `SPAWN_GRID` x `SPAWN_GRID` grid laid over the arena.
pub const SPAWN_GRID: usize = 64;
/// Softening added to squared distance so a snake's weight stays finite at its own position.
pub const SPAWN_WEIGHT_EPSILON: f64 = 100.0;

/// AUM weight of the map at `(x, y)`: every snake contributes `AUM_p / (distance^2 + epsilon)`.
pub fn aum_weight_at(x: f64, y: f64, stakes: &[(Vec2, Money)]) -> f64 {
    stakes
        .iter()
        .map(|(position, worth)| {
            let dx = wrapped_delta(x - f64::from(position.x));
            let dy = wrapped_delta(y - f64::from(position.y));
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
    let cell = f64::from(ARENA_SIZE) / SPAWN_GRID as f64;
    let mut best: Option<(f64, f64, f64)> = None;
    for row in 0..SPAWN_GRID {
        for column in 0..SPAWN_GRID {
            let x = -f64::from(ARENA_HALF_EXTENT) + (column as f64 + 0.5) * cell;
            let y = -f64::from(ARENA_HALF_EXTENT) + (row as f64 + 0.5) * cell;
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

pub fn treasury_grid_position(ball_index: usize, ball_count: usize) -> Vec2 {
    assert!(ball_count > 0 && ball_index < ball_count);
    let point_count = ball_count.div_ceil(TREASURY_BALLS_PER_POINT);
    let mut rows = 1;
    while (rows + 1) * (rows + 1) <= point_count {
        rows += 1;
    }
    while point_count % rows != 0 {
        rows -= 1;
    }
    let columns = point_count / rows;
    let point_index = ball_index / TREASURY_BALLS_PER_POINT;
    let row = point_index / columns;
    let column = point_index % columns;
    Vec2 {
        x: (column as f32 - (columns - 1) as f32 / 2.0) * TREASURY_GRID_SPACING,
        y: (row as f32 - (rows - 1) as f32 / 2.0) * TREASURY_GRID_SPACING,
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

pub fn affordable_denomination(pool: Money) -> Option<Money> {
    (pool >= BALL).then_some(BALL)
}

fn wrapped_delta(value: f64) -> f64 {
    (value + f64::from(ARENA_HALF_EXTENT)).rem_euclid(f64::from(ARENA_SIZE))
        - f64::from(ARENA_HALF_EXTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::snake::game::economy::Tier;

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
        // No other grid cell in the arena is lighter than the chosen one.
        let cell = f64::from(ARENA_SIZE) / SPAWN_GRID as f64;
        for row in 0..SPAWN_GRID {
            for column in 0..SPAWN_GRID {
                let x = -f64::from(ARENA_HALF_EXTENT) + (column as f64 + 0.5) * cell;
                let y = -f64::from(ARENA_HALF_EXTENT) + (row as f64 + 0.5) * cell;
                assert!(aum_weight_at(x, y, &stakes) >= weight);
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
        assert!(first.x >= -ARENA_HALF_EXTENT && first.x < ARENA_HALF_EXTENT);
        assert!(first.y >= -ARENA_HALF_EXTENT && first.y < ARENA_HALF_EXTENT);
    }

    #[test]
    fn spawn_point_requires_aum() {
        assert!(spawn_point([]).is_none());
        assert!(spawn_point([stake(5.0, 5.0, 0)]).is_none());
    }

    #[test]
    fn treasury_grid_places_two_balls_on_centered_ten_by_ten_coordinates() {
        let positions = (0..200)
            .map(|index| treasury_grid_position(index, 200))
            .collect::<Vec<_>>();
        let mut counts = std::collections::BTreeMap::new();
        for position in &positions {
            *counts.entry((position.x as i32, position.y as i32)).or_insert(0) += 1;
        }

        assert_eq!(counts.len(), 100);
        assert!(counts.values().all(|count| *count == 2));
        assert_eq!(positions.first().unwrap().x, -225.0);
        assert_eq!(positions.first().unwrap().y, -225.0);
        assert_eq!(positions.last().unwrap().x, 225.0);
        assert_eq!(positions.last().unwrap().y, 225.0);
    }
}
