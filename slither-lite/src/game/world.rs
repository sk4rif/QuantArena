use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    f32::consts::{PI, TAU},
};

use rand::{Rng, SeedableRng, rngs::StdRng};

use crate::{
    config::{
        ARENA_RADIUS, BASE_SPEED, BODY_SPACING, BOOST_SPEED, DIGEST_HISTORY, PROTOCOL_VERSION,
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
        PLACEMENT_VERSION, PlacementSource, center_weighted_position, decompose_greedy,
        deterministic_affordable_denomination, spawn_point, spawn_point_position,
        treasury_denominations,
    },
    spatial::SpatialIndex,
};

const SPAWN_INVULNERABLE_TICKS: u16 = TICK_RATE * 2;
const BOOST_BATCH: Money = BALL;
const MAX_GENERAL_DROPS_PER_TICK: usize = 256;
/// Extra distance beyond the head's pickup reach at which a boost ball is dropped when the snake has no body yet.
const BOOST_DROP_GAP: f32 = 30.0;
const MAX_RECEIPTS: usize = 1_024;

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
    rng: StdRng,
    tier: Tier,
    placement_seed: u64,
    placement_ball_index: u64,
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
    receipts: VecDeque<Receipt>,
    published_snakes: BTreeMap<EntityId, SnakeWire>,
    published_food: BTreeMap<EntityId, FoodWire>,
    digest_history: VecDeque<(u64, u64)>,
}

impl GameWorld {
    pub fn new(tier: Tier, placement_seed: u64) -> Self {
        let mut world = Self {
            rng: StdRng::from_os_rng(),
            tier,
            placement_seed,
            placement_ball_index: 0,
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
    fn seeded(seed: u64) -> Self {
        let mut world = Self::new(Tier::Casual, seed);
        world.rng = StdRng::seed_from_u64(seed);
        world
    }

    pub fn join(&mut self, name: String, skin: String) -> EntityId {
        let id = self.next_entity_id();
        let aim = self.rng.random_range(-PI..PI);
        self.players.insert(
            id,
            Player {
                name,
                skin,
                aim,
                boosting: false,
                last_input_seq: 0,
            },
        );
        self.enter(id);
        id
    }

    pub fn disconnect(&mut self, id: EntityId) -> Option<Receipt> {
        let receipt = self.cash_out(id, ExitReason::Disconnect);
        self.players.remove(&id);
        receipt
    }

    pub fn cash_out(&mut self, id: EntityId, reason: ExitReason) -> Option<Receipt> {
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
            reason,
            tick: self.tick,
        };
        self.next_receipt_id += 1;
        self.receipts.push_back(receipt.clone());
        while self.receipts.len() > MAX_RECEIPTS {
            self.receipts.pop_front();
        }
        self.emit_general_floor(
            PlacementSource::Rake,
            receipt.id,
            MAX_GENERAL_DROPS_PER_TICK,
        );
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
        self.emit_general_floor(PlacementSource::Tax, self.tick, MAX_GENERAL_DROPS_PER_TICK);

        let spatial = SpatialIndex::build(&self.snakes, &self.food);
        self.consume_food(&spatial);
        let mut deaths = self.detect_deaths(&spatial);
        for id in zero_worth {
            deaths.insert(id, "zeroWorth");
        }
        let mut eliminations = Vec::new();
        for (id, reason) in deaths {
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
            arena_radius: (ARENA_RADIUS * 100.0).round() as i32,
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
        self.ledger.record_ticket(self.tier.ticket());
        self.spawn_snake(id);
        self.assert_conserved();
    }

    fn spawn_snake(&mut self, id: EntityId) {
        let Some(player) = self.players.get(&id).cloned() else {
            return;
        };
        let position = self.safe_spawn_position();
        let mut body = VecDeque::new();
        for index in (1..=24).rev() {
            let sample_id = self.next_sample_id();
            body.push_back(BodyPoint {
                id: sample_id,
                position: Vec2 {
                    x: position.x - player.aim.cos() * BODY_SPACING * index as f32,
                    y: position.y - player.aim.sin() * BODY_SPACING * index as f32,
                },
            });
        }
        self.snakes.insert(
            id,
            Snake {
                id,
                name: player.name,
                skin: player.skin,
                position,
                angle: player.aim,
                aim: player.aim,
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

    fn safe_spawn_position(&mut self) -> Vec2 {
        for _ in 0..32 {
            let candidate = self.random_position(ARENA_RADIUS * 0.72);
            if self
                .snakes
                .values()
                .all(|snake| snake.position.distance_squared(candidate) > 500.0_f32.powi(2))
            {
                return candidate;
            }
        }
        self.random_position(ARENA_RADIUS * 0.5)
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
        for snake in &snakes {
            let radius = snake.radius(self.tier.ticket());
            if snake.invulnerable_ticks == 0
                && snake.position.x * snake.position.x + snake.position.y * snake.position.y
                    > (ARENA_RADIUS - radius).powi(2)
            {
                dead.insert(snake.id, "boundary");
            }
        }
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
        let spawn = self.floor_spawn_point();
        for value in balls {
            let position = self.floor_position(spawn, 0, PlacementSource::Treasury, 0);
            self.placement_ball_index += 1;
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

    fn emit_general_floor(&mut self, source: PlacementSource, source_id: u64, limit: usize) {
        let spawn = self.floor_spawn_point();
        for _ in 0..limit {
            let available = self.ledger.pending_floor.checked_sub(self.boost_pending);
            let Some(value) = deterministic_affordable_denomination(
                available,
                self.placement_seed,
                self.tick,
                self.placement_ball_index,
            ) else {
                break;
            };
            let position = self.floor_position(spawn, self.tick, source, source_id);
            self.placement_ball_index += 1;
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

    fn floor_position(
        &self,
        spawn: Option<Vec2>,
        tick: u64,
        source: PlacementSource,
        source_id: u64,
    ) -> Vec2 {
        match spawn {
            Some(spawn) => spawn_point_position(
                spawn,
                self.placement_seed,
                tick,
                source,
                source_id,
                self.placement_ball_index,
            ),
            None => center_weighted_position(
                self.placement_seed,
                tick,
                source,
                source_id,
                self.placement_ball_index,
            ),
        }
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

    fn random_position(&mut self, radius: f32) -> Vec2 {
        let angle = self.rng.random_range(0.0..TAU);
        let distance = self.rng.random::<f32>().sqrt() * radius;
        Vec2 {
            x: angle.cos() * distance,
            y: angle.sin() * distance,
        }
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
            placement_seed: format!("{:016x}", self.placement_seed),
            placement_version: PLACEMENT_VERSION,
            minimum_effective_worth_nanos: MIN_EFFECTIVE_WORTH.0,
            tax_numerator: TAX_NUMERATOR,
            tax_denominator: TAX_DENOMINATOR,
            boost_numerator: BOOST_NUMERATOR,
            boost_denominator: BOOST_DENOMINATOR,
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

/// Index 1 selects the green orb sprite in the client's food table; every ball is the same
/// denomination, so money points are uniformly green.
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
    use crate::game::placement::SPAWN_SCATTER_RADIUS;

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
        let spawn = world.floor_spawn_point().unwrap();
        // Both snakes sit on the +x side, so the emptiest zone is on the -x side.
        assert!(spawn.x < -1_000.0);
        let before = world.food.len();
        let worth = world.snakes.get(&a).unwrap().worth;
        world.snakes.get_mut(&a).unwrap().worth = worth.checked_sub(BALL);
        world.ledger.transfer_to_floor(BALL);
        world.emit_general_floor(PlacementSource::Tax, 1, 1);
        let ball = world.food.values().last().unwrap();
        assert_eq!(world.food.len(), before + 1);
        assert!(ball.position.distance_squared(spawn).sqrt() <= SPAWN_SCATTER_RADIUS + 0.01);
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
        boosted.input(boosted_id, 1, 0.0, true);
        for _ in 0..120 {
            boosted.tick();
        }
        let end = boosted.snakes.get(&boosted_id).unwrap().worth;
        // 4 s of boost is worth ~$0.80 on a $5 snake; the ball paid out must not be re-collected for free.
        let ideal_boost_cost = MIN_EFFECTIVE_WORTH.0 * BOOST_NUMERATOR * 120 / BOOST_DENOMINATOR;
        assert!(
            start.0 - end.0 >= ideal_boost_cost / 2,
            "boost cost only {} of ~{} nanos",
            start.0 - end.0,
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
    fn cash_out_and_reentry_are_conserved() {
        let mut world = GameWorld::seeded(6);
        let id = world.join("Exit".into(), "yellow".into());
        let receipt = world.cash_out(id, ExitReason::CashOut).unwrap();
        assert_eq!(receipt.gross_nanos, Tier::Casual.ticket().0);
        assert!(!world.snakes.contains_key(&id));
        assert!(world.reenter(id));
        assert_eq!(
            world.ledger.ticket_inflow,
            Tier::Casual.ticket().checked_mul(2)
        );
        world.assert_conserved();
    }

    #[test]
    fn elite_bootstrap_stays_within_json_budget() {
        let mut world = GameWorld::new(Tier::Elite, 9);
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
    fn disconnect_records_automatic_rake_receipt() {
        let mut world = GameWorld::seeded(8);
        let id = world.join("Drop".into(), "red".into());
        let receipt = world.disconnect(id).unwrap();
        assert_eq!(receipt.reason, ExitReason::Disconnect);
        assert_eq!(
            receipt.payout_nanos + receipt.platform_fee_nanos,
            receipt.gross_nanos
        );
        assert!(!world.players.contains_key(&id));
        world.assert_conserved();
    }
}
