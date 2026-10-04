use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    f32::consts::{PI, TAU},
};

use crate::games::snake::{
    config::{
        ARENA_HALF_EXTENT, BASE_SPEED, BODY_SPACING, BOOST_SPEED, DIGEST_HISTORY, PROTOCOL_VERSION,
        PUBLISH_RATE, TICK_RATE, TURN_RATE,
    },
    digest::state_digest,
    protocol::{
        Bootstrap, Delta, EconomyConfigWire, EconomyStateWire, EntityId, FoodWire,
        LeaderboardEntry, SnakePatch, SnakeWire, digest_to_hex,
    },
};

use super::{
    economy::{
        BALL, BOOST_DENOMINATOR, BOOST_NUMERATOR, DENOMINATIONS, ExitReason, FormulaRemainder,
        Ledger, MIN_EFFECTIVE_WORTH, Money, PAYOUT_BASIS_POINTS, PLATFORM_FEE_BASIS_POINTS,
        Receipt, TAX_DENOMINATOR, TAX_NUMERATOR, Tier, boost_charge, split_rake, starvation_charge,
    },
    entities::{BodyPoint, Food, Snake, Vec2},
    placement::{
        affordable_denomination, decompose_greedy, spawn_point, treasury_denominations,
        treasury_grid_position,
    },
    spatial::SpatialIndex,
};

const SPAWN_INVULNERABLE_TICKS: u16 = TICK_RATE * 2;
const SNAKE_SPAWN_GRID: usize = 64;
const INITIAL_BODY_POINTS: usize = 24;
const SPAWN_BODY_RADIUS: f32 = BODY_SPACING * (INITIAL_BODY_POINTS as f32 + 1.0) / TAU;
const BOOST_BATCH: Money = BALL;
const MAX_GENERAL_DROPS_PER_TICK: usize = 256;
/// Extra distance beyond the head's pickup reach at which a boost ball is dropped when the snake has no body yet.
const BOOST_DROP_GAP: f32 = 30.0;
const MAX_RECEIPTS: usize = 1_024;
pub const CASH_OUT_DELAY_TICKS: u64 = TICK_RATE as u64 * 10;

#[derive(Debug, Clone)]
struct Player {
    name: String,
    skin: String,
    aim: f32,
    boosting: bool,
    last_input_seq: u32,
}

#[derive(Debug, Clone)]
pub struct Elimination {
    pub player_id: EntityId,
    pub reason: String,
    pub final_worth: Money,
}

pub struct GameWorld {
    tier: Tier,
    tick: u64,
    sequence: u64,
    next_entity_id: EntityId,
    next_sample_id: u64,
    next_receipt_id: u64,
    players: BTreeMap<EntityId, Player>,
    snakes: BTreeMap<EntityId, Snake>,
    food: BTreeMap<EntityId, Food>,
    ledger: Ledger,
    boost_pending: Money,
    cash_out_deadlines: BTreeMap<EntityId, u64>,
    receipts: VecDeque<Receipt>,
    published_snakes: BTreeMap<EntityId, SnakeWire>,
    published_food: BTreeMap<EntityId, FoodWire>,
    digest_history: VecDeque<(u64, u64)>,
}

impl GameWorld {
    pub fn new(tier: Tier) -> Self {
        let mut world = Self {
            tier,
            tick: 0,
            sequence: 0,
            next_entity_id: 1,
            next_sample_id: 1,
            next_receipt_id: 1,
            players: BTreeMap::new(),
            snakes: BTreeMap::new(),
            food: BTreeMap::new(),
            ledger: Ledger::default(),
            boost_pending: Money::ZERO,
            cash_out_deadlines: BTreeMap::new(),
            receipts: VecDeque::new(),
            published_snakes: BTreeMap::new(),
            published_food: BTreeMap::new(),
            digest_history: VecDeque::new(),
        };
        world.seed_treasury();
        world.capture_published_state();
        world.record_digest();
        world.assert_conserved();
        world
    }

    #[cfg(test)]
    fn seeded(_seed: u64) -> Self {
        Self::new(Tier::Casual)
    }

    pub fn spectate(&mut self) -> EntityId {
        self.next_entity_id()
    }

    pub fn join(&mut self, name: String, skin: String) -> EntityId {
        let id = self.next_entity_id();
        self.players.insert(
            id,
            Player {
                name,
                skin,
                aim: 0.0,
                boosting: false,
                last_input_seq: 0,
            },
        );
        self.enter(id);
        id
    }

    pub fn disconnect(&mut self, id: EntityId) -> bool {
        self.players.remove(&id);
        let Some(snake) = self.snakes.get_mut(&id) else {
            return false;
        };
        snake.boosting = false;
        self.assert_conserved();
        true
    }

    pub fn request_cash_out(&mut self, id: EntityId) -> Option<u64> {
        if !self.snakes.contains_key(&id) {
            return None;
        }
        Some(
            *self
                .cash_out_deadlines
                .entry(id)
                .or_insert(self.tick + CASH_OUT_DELAY_TICKS),
        )
    }

    pub fn cancel_cash_out(&mut self, id: EntityId) -> bool {
        self.cash_out_deadlines.remove(&id).is_some()
    }

    pub fn complete_cash_outs(&mut self) -> Vec<Receipt> {
        let due = self
            .cash_out_deadlines
            .iter()
            .filter_map(|(id, deadline)| (*deadline <= self.tick).then_some(*id))
            .collect::<Vec<_>>();
        due.into_iter().filter_map(|id| self.cash_out(id)).collect()
    }

    fn cash_out(&mut self, id: EntityId) -> Option<Receipt> {
        self.cash_out_deadlines.remove(&id);
        let snake = self.snakes.remove(&id)?;
        let split = split_rake(snake.worth);
        self.ledger.record_exit(split);
        let receipt = Receipt {
            id: self.next_receipt_id,
            player_id: id,
            player_name: snake.name,
            tier: self.tier,
            gross_nanos: split.gross.0,
            payout_nanos: split.payout.0,
            platform_fee_nanos: split.platform_fee.0,
            reason: ExitReason::CashOut,
            tick: self.tick,
        };
        self.next_receipt_id += 1;
        self.receipts.push_back(receipt.clone());
        while self.receipts.len() > MAX_RECEIPTS {
            self.receipts.pop_front();
        }
        self.emit_general_floor(MAX_GENERAL_DROPS_PER_TICK);
        self.assert_conserved();
        Some(receipt)
    }

    pub fn input(&mut self, id: EntityId, input_seq: u32, aim: f32, boosting: bool) {
        if !aim.is_finite() {
            return;
        }
        let Some(player) = self.players.get_mut(&id) else {
            return;
        };
        if input_seq <= player.last_input_seq {
            return;
        }
        player.last_input_seq = input_seq;
        player.aim = normalize_angle(aim);
        player.boosting = boosting;
        if let Some(snake) = self.snakes.get_mut(&id) {
            snake.aim = player.aim;
            snake.boosting = boosting;
            snake.last_input_seq = input_seq;
        }
    }

    pub fn reenter(&mut self, id: EntityId) -> bool {
        if !self.players.contains_key(&id) || self.snakes.contains_key(&id) {
            return false;
        }
        self.enter(id);
        true
    }

    pub fn tick(&mut self) -> Vec<Elimination> {
        self.tick += 1;
        let dt = 1.0 / f32::from(TICK_RATE);
        let ids = self.snakes.keys().copied().collect::<Vec<_>>();
        let mut new_samples = Vec::new();
        let mut boost_sources = Vec::new();
        let mut zero_worth = BTreeSet::new();

        for id in ids {
            let Some(snake) = self.snakes.get_mut(&id) else {
                continue;
            };
            if snake.invulnerable_ticks > 0 {
                snake.invulnerable_ticks -= 1;
            }
            let tick_start_worth = snake.worth;
            let tax =
                starvation_charge(tick_start_worth, &mut snake.tax_remainder).min(snake.worth);
            snake.worth = snake.worth.checked_sub(tax);
            self.ledger.transfer_to_floor(tax);

            let can_boost = snake.boosting && !snake.worth.is_zero();
            if can_boost {
                let boost =
                    boost_charge(tick_start_worth, &mut snake.boost_remainder).min(snake.worth);
                snake.worth = snake.worth.checked_sub(boost);
                self.ledger.transfer_to_floor(boost);
                self.boost_pending = self.boost_pending.checked_add(boost);
                boost_sources.push(id);
            }
            snake.speed = if can_boost { BOOST_SPEED } else { BASE_SPEED };
            let difference = normalize_angle(snake.aim - snake.angle);
            snake.angle += difference.clamp(-TURN_RATE * dt, TURN_RATE * dt);
            snake.angle = normalize_angle(snake.angle);
            let previous = snake.position;
            snake.position.x += snake.angle.cos() * snake.speed * dt;
            snake.position.y += snake.angle.sin() * snake.speed * dt;
            snake.position = snake.position.wrapped();
            let last = snake
                .body
                .back()
                .map(|point| point.position)
                .unwrap_or(previous);
            if last.distance_squared(previous) >= BODY_SPACING * BODY_SPACING {
                new_samples.push((id, previous));
            }
            if snake.worth.is_zero() {
                zero_worth.insert(id);
            }
        }

        for (id, position) in new_samples {
            let sample_id = self.next_sample_id();
            if let Some(snake) = self.snakes.get_mut(&id) {
                snake.body.push_back(BodyPoint {
                    id: sample_id,
                    position,
                });
                while snake.body.len() > snake.desired_body_points(self.tier.ticket()) {
                    snake.body.pop_front();
                }
            }
        }

        self.emit_boost_batches(&boost_sources);
        self.emit_general_floor(MAX_GENERAL_DROPS_PER_TICK);

        let spatial = SpatialIndex::build(&self.snakes, &self.food);
        self.consume_food(&spatial);
        let mut deaths = self.detect_deaths(&spatial);
        for id in zero_worth {
            deaths.insert(id, "zeroWorth");
        }
        let mut eliminations = Vec::new();
        for (id, reason) in deaths {
            self.cash_out_deadlines.remove(&id);
            if let Some(snake) = self.snakes.remove(&id) {
                let final_worth = snake.worth;
                self.drop_snake_worth(&snake);
                eliminations.push(Elimination {
                    player_id: id,
                    reason: reason.to_owned(),
                    final_worth,
                });
            }
        }
        self.assert_conserved();
        eliminations
    }

    pub fn publish_delta(&mut self) -> Delta {
        let current_snakes = self.snake_wires();
        let current_food = self.food_wires();
        let mut snakes_added = Vec::new();
        let mut snakes_updated = Vec::new();
        let mut snakes_removed = Vec::new();
        let mut food_added = Vec::new();
        let mut food_removed = Vec::new();

        for (id, snake) in &current_snakes {
            match self.published_snakes.get(id) {
                Some(previous) => snakes_updated.push(snake_patch(previous, snake)),
                None => snakes_added.push(snake.clone()),
            }
        }
        for id in self.published_snakes.keys() {
            if !current_snakes.contains_key(id) {
                snakes_removed.push(*id);
            }
        }
        for (id, item) in &current_food {
            if !self.published_food.contains_key(id) {
                food_added.push(*item);
            }
        }
        for id in self.published_food.keys() {
            if !current_food.contains_key(id) {
                food_removed.push(*id);
            }
        }

        self.sequence += 1;
        self.published_snakes = current_snakes;
        self.published_food = current_food;
        let digest = self.record_digest();
        Delta {
            tick: self.tick,
            sequence: self.sequence,
            digest: digest_to_hex(digest),
            economy: self.economy_state(),
            snakes_added,
            snakes_updated,
            snakes_removed,
            food_added,
            food_removed,
            leaderboard: self.leaderboard(),
        }
    }

    pub fn bootstrap(&self, player_id: EntityId, reason: impl Into<String>) -> Bootstrap {
        let digest = self
            .digest_history
            .back()
            .map(|entry| entry.1)
            .unwrap_or_else(|| {
                state_digest(
                    &self.published_snakes.values().cloned().collect::<Vec<_>>(),
                    &self.published_food.values().copied().collect::<Vec<_>>(),
                    self.economy_state(),
                )
            });
        Bootstrap {
            protocol: PROTOCOL_VERSION,
            player_id,
            tick_rate: TICK_RATE,
            publish_rate: PUBLISH_RATE,
            arena_half_extent: (ARENA_HALF_EXTENT * 100.0).round() as i32,
            cash_out_completes_at_tick: self.cash_out_deadlines.get(&player_id).copied(),
            tick: self.tick,
            sequence: self.sequence,
            digest: digest_to_hex(digest),
            reason: reason.into(),
            economy_config: self.economy_config(),
            economy: self.economy_state(),
            snakes: self.published_snakes.values().cloned().collect(),
            food: self.published_food.values().copied().collect(),
            leaderboard: self.leaderboard(),
        }
    }

    pub fn digest_matches(&self, sequence: u64, digest: u64) -> bool {
        self.digest_history
            .iter()
            .find(|entry| entry.0 == sequence)
            .is_some_and(|entry| entry.1 == digest)
    }

    pub fn sequence_is_known(&self, sequence: u64) -> bool {
        self.digest_history.iter().any(|entry| entry.0 == sequence)
    }

    pub fn ticket(&self) -> Money {
        self.tier.ticket()
    }

    fn enter(&mut self, id: EntityId) {
        self.cash_out_deadlines.remove(&id);
        self.ledger.record_ticket(self.tier.ticket());
        self.spawn_snake(id);
        self.assert_conserved();
    }

    fn spawn_snake(&mut self, id: EntityId) {
        let Some(player) = self.players.get(&id).cloned() else {
            return;
        };
        let position = self.safe_spawn_position();
        let aim = if position.x == 0.0 && position.y == 0.0 {
            0.0
        } else {
            (-position.y).atan2(-position.x)
        };
        if let Some(player) = self.players.get_mut(&id) {
            player.aim = aim;
        }
        let heading = Vec2 {
            x: aim.cos(),
            y: aim.sin(),
        };
        let left = Vec2 {
            x: -heading.y,
            y: heading.x,
        };
        let mut body = VecDeque::new();
        for index in (1..=INITIAL_BODY_POINTS).rev() {
            let sample_id = self.next_sample_id();
            let angle = index as f32 * TAU / (INITIAL_BODY_POINTS as f32 + 1.0);
            body.push_back(BodyPoint {
                id: sample_id,
                position: Vec2 {
                    x: position.x + left.x * SPAWN_BODY_RADIUS * (1.0 - angle.cos())
                        - heading.x * SPAWN_BODY_RADIUS * angle.sin(),
                    y: position.y + left.y * SPAWN_BODY_RADIUS * (1.0 - angle.cos())
                        - heading.y * SPAWN_BODY_RADIUS * angle.sin(),
                }
                .wrapped(),
            });
        }
        self.snakes.insert(
            id,
            Snake {
                id,
                name: player.name,
                skin: player.skin,
                position,
                angle: aim,
                aim,
                boosting: player.boosting,
                speed: BASE_SPEED,
                worth: self.tier.ticket(),
                last_input_seq: player.last_input_seq,
                body,
                invulnerable_ticks: SPAWN_INVULNERABLE_TICKS,
                tax_remainder: FormulaRemainder::default(),
                boost_remainder: FormulaRemainder::default(),
            },
        );
    }

    fn safe_spawn_position(&self) -> Vec2 {
        if self.snakes.is_empty() {
            return Vec2::default();
        }
        let cell = ARENA_HALF_EXTENT * 2.0 / SNAKE_SPAWN_GRID as f32;
        let mut best = (f32::NEG_INFINITY, Vec2::default());
        for row in 0..SNAKE_SPAWN_GRID {
            for column in 0..SNAKE_SPAWN_GRID {
                let candidate = Vec2 {
                    x: -ARENA_HALF_EXTENT + (column as f32 + 0.5) * cell,
                    y: -ARENA_HALF_EXTENT + (row as f32 + 0.5) * cell,
                };
                let clearance = self
                    .snakes
                    .values()
                    .flat_map(|snake| {
                        std::iter::once(snake.position)
                            .chain(snake.body.iter().map(|point| point.position))
                    })
                    .map(|position| candidate.distance_squared(position))
                    .fold(f32::INFINITY, f32::min);
                if clearance > best.0 {
                    best = (clearance, candidate);
                }
            }
        }
        best.1
    }

    fn consume_food(&mut self, spatial: &SpatialIndex) {
        let mut consumed = BTreeSet::new();
        let mut gains: BTreeMap<EntityId, Money> = BTreeMap::new();
        for (snake_id, snake) in &self.snakes {
            for food_id in
                spatial.nearby_food(snake.position, snake.radius(self.tier.ticket()) + 24.0)
            {
                if consumed.contains(&food_id) {
                    continue;
                }
                let Some(item) = self.food.get(&food_id) else {
                    continue;
                };
                let reach = snake.radius(self.tier.ticket()) + item.radius();
                if snake.position.distance_squared(item.position) <= reach * reach {
                    consumed.insert(food_id);
                    gains
                        .entry(*snake_id)
                        .and_modify(|gain| *gain = gain.checked_add(item.value))
                        .or_insert(item.value);
                }
            }
        }
        for id in consumed {
            self.food.remove(&id);
        }
        for (id, gain) in gains {
            if let Some(snake) = self.snakes.get_mut(&id) {
                snake.worth = snake.worth.checked_add(gain);
            }
        }
    }

    fn detect_deaths(&self, spatial: &SpatialIndex) -> BTreeMap<EntityId, &'static str> {
        let mut dead = BTreeMap::new();
        let snakes = self.snakes.values().collect::<Vec<_>>();
        for left_index in 0..snakes.len() {
            let left = snakes[left_index];
            if left.invulnerable_ticks > 0 {
                continue;
            }
            let left_radius = left.radius(self.tier.ticket());
            for right in snakes.iter().skip(left_index + 1).copied() {
                if right.invulnerable_ticks == 0 {
                    let reach = left_radius + right.radius(self.tier.ticket());
                    if left.position.distance_squared(right.position) <= reach * reach {
                        if left.worth == right.worth {
                            dead.insert(left.id, "headToHead");
                            dead.insert(right.id, "headToHead");
                        } else if left.worth < right.worth {
                            dead.insert(left.id, "headToHead");
                        } else {
                            dead.insert(right.id, "headToHead");
                        }
                    }
                }
            }
            for (owner_id, position) in spatial.nearby_body(left.position, left_radius + 48.0) {
                if left.id == owner_id {
                    continue;
                }
                let Some(owner) = self.snakes.get(&owner_id) else {
                    continue;
                };
                let reach = left_radius + owner.radius(self.tier.ticket()) * 0.7;
                if left.position.distance_squared(position) <= reach * reach {
                    dead.insert(left.id, "bodyCollision");
                    break;
                }
            }
        }
        dead
    }

    fn drop_snake_worth(&mut self, snake: &Snake) {
        self.ledger.transfer_to_floor(snake.worth);
        let (balls, _) = decompose_greedy(snake.worth);
        let path = std::iter::once(snake.position)
            .chain(snake.body.iter().rev().map(|point| point.position))
            .collect::<Vec<_>>();
        let ball_count = balls.len().max(1);
        for (index, value) in balls.into_iter().enumerate() {
            let path_index = index * path.len() / ball_count;
            self.ledger.emit_floor(value);
            self.spawn_food_at(
                path[path_index.min(path.len() - 1)],
                value,
                color_for_value(value),
            );
        }
    }

    fn seed_treasury(&mut self) {
        let amount = self.tier.ticket().checked_mul(20);
        self.ledger.seed_treasury(amount);
        let (balls, _) = treasury_denominations(amount);
        let ball_count = balls.len();
        for (index, value) in balls.into_iter().enumerate() {
            let position = treasury_grid_position(index, ball_count);
            self.ledger.emit_floor(value);
            self.spawn_food_at(position, value, color_for_value(value));
        }
    }

    fn emit_boost_batches(&mut self, sources: &[EntityId]) {
        if sources.is_empty() {
            self.boost_pending = Money::ZERO;
            return;
        }
        let mut source_index = 0;
        while self.boost_pending >= BOOST_BATCH {
            let id = sources[source_index % sources.len()];
            source_index += 1;
            let Some(snake) = self.snakes.get(&id) else {
                break;
            };
            let position = boost_drop_position(snake, self.tier.ticket());
            self.boost_pending = self.boost_pending.checked_sub(BOOST_BATCH);
            self.ledger.emit_floor(BOOST_BATCH);
            self.spawn_food_at(position, BALL, color_for_value(BALL));
        }
    }

    fn emit_general_floor(&mut self, limit: usize) {
        let position = self.floor_spawn_point().unwrap_or_default();
        for _ in 0..limit {
            let available = self.ledger.pending_floor.checked_sub(self.boost_pending);
            let Some(value) = affordable_denomination(available) else {
                break;
            };
            self.ledger.emit_floor(value);
            self.spawn_food_at(position, value, color_for_value(value));
        }
    }

    /// Mirror of the AUM-weighted center of mass of the live snakes; `None` while nobody holds AUM.
    fn floor_spawn_point(&self) -> Option<Vec2> {
        spawn_point(
            self.snakes
                .values()
                .map(|snake| (snake.position, snake.worth)),
        )
    }

    fn spawn_food_at(&mut self, position: Vec2, value: Money, color: u8) {
        let id = self.next_entity_id();
        self.food.insert(
            id,
            Food {
                id,
                position,
                value,
                color,
            },
        );
    }

    fn snake_wires(&self) -> BTreeMap<EntityId, SnakeWire> {
        self.snakes
            .iter()
            .map(|(id, snake)| (*id, snake.to_wire(self.tier.ticket())))
            .collect()
    }

    fn food_wires(&self) -> BTreeMap<EntityId, FoodWire> {
        self.food
            .iter()
            .map(|(id, item)| (*id, item.to_wire()))
            .collect()
    }

    fn capture_published_state(&mut self) {
        self.published_snakes = self.snake_wires();
        self.published_food = self.food_wires();
    }

    fn record_digest(&mut self) -> u64 {
        let digest = state_digest(
            &self.published_snakes.values().cloned().collect::<Vec<_>>(),
            &self.published_food.values().copied().collect::<Vec<_>>(),
            self.economy_state(),
        );
        self.digest_history.push_back((self.sequence, digest));
        while self.digest_history.len() > DIGEST_HISTORY {
            self.digest_history.pop_front();
        }
        digest
    }

    fn economy_config(&self) -> EconomyConfigWire {
        EconomyConfigWire {
            tier: self.tier.key().to_owned(),
            tier_label: self.tier.label().to_owned(),
            ticket_nanos: self.tier.ticket().0,
            denominations_nanos: DENOMINATIONS.iter().map(|money| money.0).collect(),
            economy_tick_rate: TICK_RATE,
            treasury_seed_nanos: self.tier.ticket().checked_mul(20).0,
            minimum_effective_worth_nanos: MIN_EFFECTIVE_WORTH.0,
            tax_numerator: TAX_NUMERATOR,
            tax_denominator: TAX_DENOMINATOR,
            boost_numerator: BOOST_NUMERATOR,
            boost_denominator: BOOST_DENOMINATOR,
            cash_out_delay_ticks: CASH_OUT_DELAY_TICKS,
            payout_basis_points: PAYOUT_BASIS_POINTS,
            platform_fee_basis_points: PLATFORM_FEE_BASIS_POINTS,
        }
    }

    fn economy_state(&self) -> EconomyStateWire {
        EconomyStateWire {
            pending_floor_nanos: self.ledger.pending_floor.0,
            ticket_inflow_nanos: self.ledger.ticket_inflow.0,
            payouts_nanos: self.ledger.payouts.0,
            platform_fees_nanos: self.ledger.platform_fees.0,
        }
    }

    fn leaderboard(&self) -> Vec<LeaderboardEntry> {
        let mut entries = self
            .snakes
            .values()
            .map(|snake| LeaderboardEntry {
                id: snake.id,
                name: snake.name.clone(),
                worth_nanos: snake.worth.0,
            })
            .collect::<Vec<_>>();
        entries.sort_unstable_by(|left, right| {
            right
                .worth_nanos
                .cmp(&left.worth_nanos)
                .then_with(|| left.id.cmp(&right.id))
        });
        entries.truncate(10);
        entries
    }

    fn assert_conserved(&self) {
        let live = self
            .snakes
            .values()
            .fold(Money::ZERO, |total, snake| total.checked_add(snake.worth));
        let floor = self
            .food
            .values()
            .fold(Money::ZERO, |total, item| total.checked_add(item.value));
        assert!(
            self.ledger.is_conserved(live, floor),
            "economy conservation invariant failed"
        );
    }

    fn next_entity_id(&mut self) -> EntityId {
        let id = self.next_entity_id;
        self.next_entity_id = self
            .next_entity_id
            .checked_add(1)
            .expect("entity ID exhausted");
        id
    }

    fn next_sample_id(&mut self) -> u64 {
        let id = self.next_sample_id;
        self.next_sample_id = self
            .next_sample_id
            .checked_add(1)
            .expect("sample ID exhausted");
        id
    }
}

fn snake_patch(previous: &SnakeWire, current: &SnakeWire) -> SnakePatch {
    let overlap_start = current.body.first().and_then(|first| {
        previous
            .body
            .iter()
            .position(|point| point.id == first.id)
            .filter(|start| {
                let previous_suffix = &previous.body[*start..];
                previous_suffix.len() <= current.body.len()
                    && previous_suffix
                        .iter()
                        .zip(&current.body)
                        .all(|(left, right)| left == right)
            })
    });
    let (trim_body, append_body, replace_body) = match overlap_start {
        Some(start) => {
            let overlap = previous.body.len() - start;
            (start, current.body[overlap..].to_vec(), None)
        }
        None if previous.body.is_empty() => (0, current.body.clone(), None),
        None => (0, Vec::new(), Some(current.body.clone())),
    };
    SnakePatch {
        id: current.id,
        x: current.x,
        y: current.y,
        angle: current.angle,
        speed: current.speed,
        radius: current.radius,
        worth_nanos: current.worth_nanos,
        last_input_seq: current.last_input_seq,
        trim_body,
        append_body,
        replace_body,
    }
}

/// Every ball has the same denomination, so money points share one color value.
fn color_for_value(_value: Money) -> u8 {
    1
}

/// Boost balls are left on the trail, at the snake's tail, so the owner cannot re-collect the
/// payment in the same tick. A snake with no body yet drops it just outside its own pickup reach.
fn boost_drop_position(snake: &Snake, ticket: Money) -> Vec2 {
    if let Some(tail) = snake.body.front() {
        return tail.position;
    }
    let gap = snake.radius(ticket) + BOOST_DROP_GAP;
    Vec2 {
        x: snake.position.x - snake.angle.cos() * gap,
        y: snake.position.y - snake.angle.sin() * gap,
    }
}

fn normalize_angle(value: f32) -> f32 {
    (value + PI).rem_euclid(TAU) - PI
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spectator_gets_an_identity_without_entering_the_economy() {
        let mut world = GameWorld::seeded(1);
        let ticket_inflow = world.ledger.ticket_inflow;
        let snake_count = world.snakes.len();
        let player_count = world.players.len();
        let id = world.spectate();
        let bootstrap = world.bootstrap(id, "spectating");

        assert_eq!(bootstrap.player_id, id);
        assert!(!world.players.contains_key(&id));
        assert!(!world.snakes.contains_key(&id));
        assert_eq!(world.players.len(), player_count);
        assert_eq!(world.snakes.len(), snake_count);
        assert_eq!(world.ledger.ticket_inflow, ticket_inflow);
        world.assert_conserved();
    }

    #[test]
    fn empty_arena_spawns_at_center() {
        let world = GameWorld::seeded(2);

        let spawn = world.safe_spawn_position();

        assert_eq!(spawn.x, 0.0);
        assert_eq!(spawn.y, 0.0);
    }

    #[test]
    fn spawn_maximizes_distance_from_heads_and_body_points() {
        let mut world = GameWorld::seeded(3);
        let id = world.join("Existing".into(), "green".into());
        let snake = world.snakes.get_mut(&id).unwrap();
        snake.position = Vec2 { x: 0.0, y: 0.0 };
        snake.body.clear();
        snake.body.push_back(BodyPoint {
            id: 1,
            position: Vec2 {
                x: -2_950.0,
                y: -2_950.0,
            },
        });
        let occupied = [snake.position, snake.body[0].position];

        let spawn = world.safe_spawn_position();
        let clearance = occupied
            .iter()
            .map(|position| spawn.distance_squared(*position))
            .reduce(f32::min)
            .unwrap();
        let cell = ARENA_HALF_EXTENT * 2.0 / SNAKE_SPAWN_GRID as f32;
        for row in 0..SNAKE_SPAWN_GRID {
            for column in 0..SNAKE_SPAWN_GRID {
                let candidate = Vec2 {
                    x: -ARENA_HALF_EXTENT + (column as f32 + 0.5) * cell,
                    y: -ARENA_HALF_EXTENT + (row as f32 + 0.5) * cell,
                };
                let candidate_clearance = occupied
                    .iter()
                    .map(|position| candidate.distance_squared(*position))
                    .reduce(f32::min)
                    .unwrap();
                assert!(clearance >= candidate_clearance);
            }
        }
    }

    #[test]
    fn spawned_snake_is_circular_and_faces_arena_center() {
        let mut world = GameWorld::seeded(4);
        world.join("Existing".into(), "green".into());

        let id = world.join("Circular".into(), "blue".into());
        let snake = world.snakes.get(&id).unwrap();
        let expected_aim = (-snake.position.y).atan2(-snake.position.x);
        assert!((normalize_angle(snake.angle - expected_aim)).abs() < 0.001);

        let left = Vec2 {
            x: -snake.angle.sin(),
            y: snake.angle.cos(),
        };
        let center = Vec2 {
            x: snake.position.x + left.x * SPAWN_BODY_RADIUS,
            y: snake.position.y + left.y * SPAWN_BODY_RADIUS,
        };
        assert_eq!(snake.body.len(), INITIAL_BODY_POINTS);
        for point in &snake.body {
            assert!(
                (point.position.distance_squared(center).sqrt() - SPAWN_BODY_RADIUS).abs() < 0.01
            );
        }
    }

    #[test]
    fn movement_wraps_across_the_square_edge_without_elimination() {
        let mut world = GameWorld::seeded(2);
        let id = world.join("Wrapper".into(), "green".into());
        let snake = world.snakes.get_mut(&id).unwrap();
        snake.position = Vec2 {
            x: ARENA_HALF_EXTENT - 1.0,
            y: 0.0,
        };
        snake.angle = 0.0;
        snake.aim = 0.0;
        let events = world.tick();
        assert!(events.is_empty());
        assert!(world.snakes.get(&id).unwrap().position.x < -ARENA_HALF_EXTENT + 10.0);
    }

    #[test]
    fn collisions_and_pickups_work_across_the_wrap_seam() {
        let mut world = GameWorld::seeded(3);
        let left = world.join("Left".into(), "green".into());
        let right = world.join("Right".into(), "blue".into());
        world.snakes.get_mut(&left).unwrap().position = Vec2 {
            x: -ARENA_HALF_EXTENT + 5.0,
            y: 0.0,
        };
        world.snakes.get_mut(&right).unwrap().position = Vec2 {
            x: ARENA_HALF_EXTENT - 5.0,
            y: 0.0,
        };
        world.snakes.get_mut(&left).unwrap().invulnerable_ticks = 0;
        world.snakes.get_mut(&right).unwrap().invulnerable_ticks = 0;
        let spatial = SpatialIndex::build(&world.snakes, &world.food);
        let deaths = world.detect_deaths(&spatial);
        assert_eq!(deaths.get(&left), Some(&"headToHead"));
        assert_eq!(deaths.get(&right), Some(&"headToHead"));

        world.snakes.get_mut(&right).unwrap().invulnerable_ticks = 1;
        let worth = world.snakes.get(&left).unwrap().worth;
        world.snakes.get_mut(&left).unwrap().worth = worth.checked_sub(BALL);
        world.ledger.transfer_to_floor(BALL);
        world.ledger.emit_floor(BALL);
        let ball_id = world.next_entity_id();
        world.food.insert(
            ball_id,
            Food {
                id: ball_id,
                position: Vec2 {
                    x: ARENA_HALF_EXTENT - 5.0,
                    y: 0.0,
                },
                value: BALL,
                color: 1,
            },
        );
        let spatial = SpatialIndex::build(&world.snakes, &world.food);
        world.consume_food(&spatial);
        assert!(!world.food.contains_key(&ball_id));
        assert_eq!(world.snakes.get(&left).unwrap().worth, worth);
        world.assert_conserved();
    }

    #[test]
    fn collecting_ball_moves_value_without_minting() {
        let mut world = GameWorld::seeded(3);
        let id = world.join("Eater".into(), "green".into());
        let position = world.snakes.get(&id).unwrap().position;
        let ball_id = world.next_entity_id();
        world.snakes.get_mut(&id).unwrap().worth =
            world.snakes.get(&id).unwrap().worth.checked_sub(BALL);
        world.ledger.transfer_to_floor(BALL);
        world.ledger.emit_floor(BALL);
        world.food.insert(
            ball_id,
            Food {
                id: ball_id,
                position,
                value: BALL,
                color: 1,
            },
        );
        let spatial = SpatialIndex::build(&world.snakes, &world.food);
        world.consume_food(&spatial);
        assert_eq!(world.snakes.get(&id).unwrap().worth, world.tier.ticket());
        world.assert_conserved();
    }

    #[test]
    fn floor_money_spawns_in_the_lowest_aum_weight_zone() {
        let mut world = GameWorld::seeded(5);
        let a = world.join("A".into(), "green".into());
        let b = world.join("B".into(), "blue".into());
        world.snakes.get_mut(&a).unwrap().position = Vec2 { x: 1_000.0, y: 0.0 };
        world.snakes.get_mut(&b).unwrap().position = Vec2 {
            x: 1_000.0,
            y: 400.0,
        };
        let before = world.food.len();
        let worth = world.snakes.get(&a).unwrap().worth;
        world.snakes.get_mut(&a).unwrap().worth = worth.checked_sub(BALL);
        world.ledger.transfer_to_floor(BALL);
        let spawn = world.floor_spawn_point().unwrap();
        // Both snakes sit on the +x side, so the emptiest zone is on the -x side.
        assert!(spawn.x < -1_000.0);
        world.emit_general_floor(1);
        let ball = world.food.values().last().unwrap();
        assert_eq!(world.food.len(), before + 1);
        assert_eq!(ball.position.x, spawn.x);
        assert_eq!(ball.position.y, spawn.y);
        world.assert_conserved();
    }

    #[test]
    fn boost_batch_creates_one_ball() {
        let mut world = GameWorld::seeded(4);
        let id = world.join("Boost".into(), "red".into());
        world.snakes.get_mut(&id).unwrap().worth = world
            .snakes
            .get(&id)
            .unwrap()
            .worth
            .checked_sub(BOOST_BATCH);
        world.boost_pending = BOOST_BATCH;
        world.ledger.transfer_to_floor(BOOST_BATCH);
        let before = world.food.len();
        world.emit_boost_batches(&[id]);
        assert_eq!(world.food.len() - before, 1);
        assert_eq!(world.boost_pending, Money::ZERO);
        world.assert_conserved();
    }

    #[test]
    fn death_distributes_all_worth_across_body_and_residual() {
        let mut world = GameWorld::seeded(5);
        let id = world.join("Victim".into(), "blue".into());
        let snake = world.snakes.remove(&id).unwrap();
        let before_floor = world
            .food
            .values()
            .fold(Money::ZERO, |total, item| total.checked_add(item.value));
        let before_pending = world.ledger.pending_floor;
        world.drop_snake_worth(&snake);
        let after_floor = world
            .food
            .values()
            .fold(Money::ZERO, |total, item| total.checked_add(item.value));
        let transferred = after_floor
            .checked_sub(before_floor)
            .checked_add(world.ledger.pending_floor.checked_sub(before_pending));
        assert_eq!(transferred, snake.worth);
        world.assert_conserved();
    }

    #[test]
    fn full_boost_ticks_preserve_conservation() {
        let mut world = GameWorld::seeded(6);
        let id = world.join("Runner".into(), "purple".into());
        let start = world.snakes.get(&id).unwrap().worth;
        world.input(id, 1, 0.0, true);
        for _ in 0..120 {
            world.tick();
        }
        assert!(world.snakes.get(&id).unwrap().worth < start);
        world.assert_conserved();
    }

    #[test]
    fn boosting_has_a_real_net_cost() {
        let mut boosted = GameWorld::seeded(6);
        let boosted_id = boosted.join("Runner".into(), "purple".into());
        let start = boosted.snakes.get(&boosted_id).unwrap().worth;
        let initial_food = boosted.food.clone();
        boosted.input(boosted_id, 1, 0.0, true);
        for _ in 0..120 {
            boosted.tick();
        }
        let end = boosted.snakes.get(&boosted_id).unwrap().worth;
        let ambient_pickups = initial_food
            .iter()
            .filter(|(id, _)| !boosted.food.contains_key(id))
            .fold(Money::ZERO, |total, (_, item)| {
                total.checked_add(item.value)
            });
        let net_cost = start.checked_add(ambient_pickups).checked_sub(end);
        // 4 s of boost is worth ~$0.80 on a $5 snake; the ball paid out must not be re-collected for free.
        let ideal_boost_cost = MIN_EFFECTIVE_WORTH.0 * BOOST_NUMERATOR * 120 / BOOST_DENOMINATOR;
        assert!(
            net_cost.0 >= ideal_boost_cost / 2,
            "boost cost only {} of ~{} nanos",
            net_cost.0,
            ideal_boost_cost
        );
        boosted.assert_conserved();
    }

    #[test]
    fn zero_worth_eliminates_and_requires_reentry() {
        let mut world = GameWorld::seeded(7);
        let id = world.join("Empty".into(), "orange".into());
        let transferred = world.tier.ticket().checked_sub(Money(1));
        world.snakes.get_mut(&id).unwrap().worth = Money(1);
        world.ledger.transfer_to_floor(transferred);
        let events = world.tick();
        assert!(!world.snakes.contains_key(&id));
        assert!(
            events
                .iter()
                .any(|event| event.player_id == id && event.reason == "zeroWorth")
        );
        assert!(world.reenter(id));
        world.assert_conserved();
    }

    #[test]
    fn cash_out_waits_ten_seconds_and_reentry_is_conserved() {
        let mut world = GameWorld::seeded(6);
        let id = world.join("Exit".into(), "yellow".into());
        let deadline = world.request_cash_out(id).unwrap();
        assert_eq!(deadline, CASH_OUT_DELAY_TICKS);
        assert_eq!(
            world.bootstrap(id, "test").cash_out_completes_at_tick,
            Some(deadline)
        );
        for _ in 1..CASH_OUT_DELAY_TICKS {
            world.tick();
            assert!(world.complete_cash_outs().is_empty());
            assert!(world.snakes.contains_key(&id));
        }
        world.tick();
        let final_worth = world.snakes.get(&id).unwrap().worth;
        let receipts = world.complete_cash_outs();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].gross_nanos, final_worth.0);
        assert!(!world.snakes.contains_key(&id));
        assert!(world.reenter(id));
        assert_eq!(
            world.ledger.ticket_inflow,
            Tier::Casual.ticket().checked_mul(2)
        );
        world.assert_conserved();
    }

    #[test]
    fn pending_cash_out_can_be_canceled_and_death_prevents_payout() {
        let mut world = GameWorld::seeded(7);
        let id = world.join("Patient".into(), "yellow".into());
        world.request_cash_out(id).unwrap();
        assert!(world.cancel_cash_out(id));
        for _ in 0..=CASH_OUT_DELAY_TICKS {
            world.tick();
        }
        assert!(world.complete_cash_outs().is_empty());
        assert!(world.snakes.contains_key(&id));

        world.request_cash_out(id).unwrap();
        let transferred = world.snakes.get(&id).unwrap().worth.checked_sub(Money(1));
        world.snakes.get_mut(&id).unwrap().worth = Money(1);
        world.ledger.transfer_to_floor(transferred);
        let eliminations = world.tick();
        assert!(eliminations.iter().any(|event| event.player_id == id));
        assert!(world.complete_cash_outs().is_empty());
        assert!(world.receipts.is_empty());
        assert_eq!(world.ledger.payouts, Money::ZERO);
        world.assert_conserved();
    }

    #[test]
    fn elite_bootstrap_stays_within_json_budget() {
        let mut world = GameWorld::new(Tier::Elite);
        let id = world.join("Elite".into(), "purple".into());
        world.publish_delta();
        let bootstrap = world.bootstrap(id, "test");
        let bytes = serde_json::to_vec(&bootstrap).unwrap();
        assert!(bootstrap.food.len() < 10_000);
        assert!(
            bytes.len() < 2_000_000,
            "elite bootstrap was {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn disconnect_abandons_snake_until_natural_elimination() {
        let mut world = GameWorld::seeded(8);
        let id = world.join("Drop".into(), "red".into());
        world.input(id, 1, 0.0, true);
        let start_position = world.snakes.get(&id).unwrap().position;
        let start_worth = world.snakes.get(&id).unwrap().worth;

        assert!(world.disconnect(id));
        assert!(!world.players.contains_key(&id));
        assert!(world.snakes.contains_key(&id));
        assert!(!world.snakes.get(&id).unwrap().boosting);
        assert!(world.receipts.is_empty());
        assert_eq!(world.ledger.payouts, Money::ZERO);

        assert!(world.tick().is_empty());
        let snake = world.snakes.get(&id).unwrap();
        assert!(snake.position.distance_squared(start_position) > 0.0);
        assert!(snake.worth < start_worth);

        let transferred = snake.worth.checked_sub(Money(1));
        world.snakes.get_mut(&id).unwrap().worth = Money(1);
        world.ledger.transfer_to_floor(transferred);
        let eliminations = world.tick();
        assert!(
            eliminations
                .iter()
                .any(|event| event.player_id == id && event.reason == "zeroWorth")
        );
        assert!(!world.snakes.contains_key(&id));
        assert!(world.receipts.is_empty());
        assert_eq!(world.ledger.payouts, Money::ZERO);
        world.assert_conserved();
    }

    #[test]
    fn disconnected_snake_completes_pending_cash_out_if_alive() {
        let mut world = GameWorld::seeded(9);
        let id = world.join("Patient".into(), "blue".into());
        world.request_cash_out(id).unwrap();
        world.cash_out_deadlines.insert(id, world.tick + 1);

        assert!(world.disconnect(id));
        assert_eq!(world.cash_out_deadlines.get(&id), Some(&1));
        assert!(world.tick().is_empty());
        let final_worth = world.snakes.get(&id).unwrap().worth;
        let receipts = world.complete_cash_outs();

        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].player_id, id);
        assert_eq!(receipts[0].payout_nanos, final_worth.0);
        assert!(!world.players.contains_key(&id));
        assert!(!world.snakes.contains_key(&id));
        assert_eq!(world.ledger.payouts, final_worth);
        world.assert_conserved();
    }
}
