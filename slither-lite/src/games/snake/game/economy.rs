use std::{fmt, str::FromStr};

use serde::Serialize;

pub const NANOS_PER_DOLLAR: u64 = 1_000_000_000;
pub const MIN_EFFECTIVE_WORTH: Money = Money::from_dollars(5);
pub const INITIAL_TREASURY_TICKETS: u64 = 16;
pub const LIQUIDITY_RATIO_SCALE: u64 = 1_000_000;
pub const LIQUIDITY_RATIO_LOW_PPM: u64 = 250_000;
pub const LIQUIDITY_RATIO_HIGH_PPM: u64 = 650_000;
pub const STARVATION_MIN_NUMERATOR: u64 = 25_672;
pub const STARVATION_MAX_NUMERATOR: u64 = 96_266;
pub const STARVATION_DENOMINATOR: u64 = 1_000_000_000;
pub const INHERITANCE_TAX_MIN_BASIS_POINTS: u16 = 200;
pub const INHERITANCE_TAX_MAX_BASIS_POINTS: u16 = 2_000;
pub const BOOST_NUMERATOR: u64 = 2_667;
pub const BOOST_DENOMINATOR: u64 = 2_000_000;
pub const PLATFORM_FEE_BASIS_POINTS: u16 = 200;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct Money(pub u64);

impl Money {
    pub const ZERO: Self = Self(0);

    pub const fn from_dollars(dollars: u64) -> Self {
        Self(dollars * NANOS_PER_DOLLAR)
    }

    pub fn checked_add(self, other: Self) -> Self {
        Self(self.0.checked_add(other.0).expect("money overflow"))
    }

    pub fn checked_sub(self, other: Self) -> Self {
        Self(self.0.checked_sub(other.0).expect("money underflow"))
    }

    pub fn checked_mul(self, multiplier: u64) -> Self {
        Self(self.0.checked_mul(multiplier).expect("money overflow"))
    }

    pub fn min(self, other: Self) -> Self {
        Self(self.0.min(other.0))
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn dollars(self) -> f64 {
        self.0 as f64 / NANOS_PER_DOLLAR as f64
    }
}

impl fmt::Display for Money {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "${:.3}", self.dollars())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    /// Paper-money level for practice and bot training.
    Paper,
    Casual,
    Mid,
    Standard,
    High,
    Elite,
}

impl Tier {
    pub const fn key(self) -> &'static str {
        match self {
            Self::Paper => "paper",
            Self::Casual => "casual",
            Self::Mid => "mid",
            Self::Standard => "standard",
            Self::High => "high",
            Self::Elite => "elite",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Paper => "Paper",
            Self::Casual => "Casual",
            Self::Mid => "Mid",
            Self::Standard => "Standard",
            Self::High => "High",
            Self::Elite => "Elite",
        }
    }

    pub const fn ticket(self) -> Money {
        match self {
            Self::Paper | Self::Casual => Money::from_dollars(5),
            Self::Mid => Money::from_dollars(25),
            Self::Standard => Money::from_dollars(50),
            Self::High => Money::from_dollars(100),
            Self::Elite => Money::from_dollars(150),
        }
    }

    pub const fn coin(self) -> Money {
        Money(self.ticket().0 / 100)
    }
}

impl FromStr for Tier {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "paper" => Ok(Self::Paper),
            "casual" => Ok(Self::Casual),
            "mid" => Ok(Self::Mid),
            "standard" => Ok(Self::Standard),
            "high" => Ok(Self::High),
            "elite" => Ok(Self::Elite),
            _ => Err(format!("unknown tier {value:?}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FormulaRemainder {
    value: u64,
}

impl FormulaRemainder {
    pub fn charge(&mut self, worth: Money, numerator: u64, denominator: u64) -> Money {
        let effective = worth.0.max(MIN_EFFECTIVE_WORTH.0);
        let scaled = u128::from(effective) * u128::from(numerator) + u128::from(self.value);
        let charge = scaled / u128::from(denominator);
        self.value = (scaled % u128::from(denominator)) as u64;
        Money(charge.min(u128::from(u64::MAX)) as u64).min(worth)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaxSchedule {
    pub floor_liquidity_ratio_ppm: u64,
    pub starvation_numerator: u64,
    pub inheritance_tax_basis_points: u16,
}

pub fn tax_schedule(live_worth: Money, floor_liquidity: Money) -> TaxSchedule {
    let total = u128::from(live_worth.0) + u128::from(floor_liquidity.0);
    let ratio = if total == 0 {
        0
    } else {
        ((u128::from(floor_liquidity.0) * u128::from(LIQUIDITY_RATIO_SCALE)) / total) as u64
    };
    let normalized = ratio
        .saturating_sub(LIQUIDITY_RATIO_LOW_PPM)
        .min(LIQUIDITY_RATIO_HIGH_PPM - LIQUIDITY_RATIO_LOW_PPM);
    let range = LIQUIDITY_RATIO_HIGH_PPM - LIQUIDITY_RATIO_LOW_PPM;
    let x = u128::from(normalized) * u128::from(LIQUIDITY_RATIO_SCALE) / u128::from(range);
    let scale = u128::from(LIQUIDITY_RATIO_SCALE);
    let smooth = x * x * (3 * scale - 2 * x) / (scale * scale);
    let starvation_range = STARVATION_MAX_NUMERATOR - STARVATION_MIN_NUMERATOR;
    let starvation_reduction =
        u128::from(starvation_range) * smooth / u128::from(LIQUIDITY_RATIO_SCALE);
    let inheritance_range =
        u64::from(INHERITANCE_TAX_MAX_BASIS_POINTS - INHERITANCE_TAX_MIN_BASIS_POINTS);
    let inheritance_reduction =
        u128::from(inheritance_range) * smooth / u128::from(LIQUIDITY_RATIO_SCALE);
    TaxSchedule {
        floor_liquidity_ratio_ppm: ratio,
        starvation_numerator: STARVATION_MAX_NUMERATOR - starvation_reduction as u64,
        inheritance_tax_basis_points: INHERITANCE_TAX_MAX_BASIS_POINTS
            - inheritance_reduction as u16,
    }
}

pub fn starvation_charge(worth: Money, numerator: u64, remainder: &mut FormulaRemainder) -> Money {
    remainder.charge(worth, numerator, STARVATION_DENOMINATOR)
}

pub fn boost_charge(worth: Money, remainder: &mut FormulaRemainder) -> Money {
    remainder.charge(worth, BOOST_NUMERATOR, BOOST_DENOMINATOR)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RakeSplit {
    pub gross: Money,
    pub payout: Money,
    pub inheritance_tax: Money,
    pub platform_fee: Money,
}

pub fn split_rake(gross: Money, inheritance_tax_basis_points: u16) -> RakeSplit {
    let inheritance_tax =
        Money(((u128::from(gross.0) * u128::from(inheritance_tax_basis_points)) / 10_000) as u64);
    let after_inheritance = gross.checked_sub(inheritance_tax);
    let platform_fee = Money(
        ((u128::from(after_inheritance.0) * u128::from(PLATFORM_FEE_BASIS_POINTS)) / 10_000) as u64,
    );
    let payout = after_inheritance.checked_sub(platform_fee);
    RakeSplit {
        gross,
        payout,
        inheritance_tax,
        platform_fee,
    }
}

#[derive(Debug, Clone, Default)]
pub struct Ledger {
    pub ticket_inflow: Money,
    pub initial_treasury: Money,
    pub pending_floor: Money,
    pub payouts: Money,
    pub platform_fees: Money,
}

impl Ledger {
    pub fn record_ticket(&mut self, ticket: Money) {
        self.ticket_inflow = self.ticket_inflow.checked_add(ticket);
    }

    pub fn fund_initial_treasury(&mut self, amount: Money) {
        self.initial_treasury = self.initial_treasury.checked_add(amount);
        self.pending_floor = self.pending_floor.checked_add(amount);
    }

    pub fn transfer_to_floor(&mut self, amount: Money) {
        self.pending_floor = self.pending_floor.checked_add(amount);
    }

    pub fn emit_floor(&mut self, amount: Money) {
        self.pending_floor = self.pending_floor.checked_sub(amount);
    }

    pub fn record_exit(&mut self, split: RakeSplit) {
        self.payouts = self.payouts.checked_add(split.payout);
        self.pending_floor = self.pending_floor.checked_add(split.inheritance_tax);
        self.platform_fees = self.platform_fees.checked_add(split.platform_fee);
    }

    pub fn is_conserved(&self, live_worth: Money, floor_balls: Money) -> bool {
        let inflow = self.ticket_inflow.checked_add(self.initial_treasury);
        let accounted = live_worth
            .checked_add(floor_balls)
            .checked_add(self.pending_floor)
            .checked_add(self.payouts)
            .checked_add(self.platform_fees);
        inflow == accounted
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExitReason {
    CashOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: u64,
    pub player_id: u32,
    pub player_name: String,
    pub tier: Tier,
    pub gross_nanos: u64,
    pub payout_nanos: u64,
    pub inheritance_tax_nanos: u64,
    pub inheritance_tax_basis_points: u16,
    pub platform_fee_nanos: u64,
    pub reason: ExitReason,
    pub tick: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_tickets_match_rules() {
        assert_eq!(Tier::Paper.ticket(), Money::from_dollars(5));
        assert_eq!(Tier::Casual.ticket(), Money::from_dollars(5));
        assert_eq!(Tier::Mid.ticket(), Money::from_dollars(25));
        assert_eq!(Tier::Standard.ticket(), Money::from_dollars(50));
        assert_eq!(Tier::High.ticket(), Money::from_dollars(100));
        assert_eq!(Tier::Elite.ticket(), Money::from_dollars(150));
    }

    #[test]
    fn coins_are_one_percent_of_the_tier_ticket() {
        for tier in [
            Tier::Paper,
            Tier::Casual,
            Tier::Mid,
            Tier::Standard,
            Tier::High,
            Tier::Elite,
        ] {
            assert_eq!(tier.coin().checked_mul(100), tier.ticket());
        }
    }

    #[test]
    fn dynamic_schedule_clamps_and_reduces_taxes_as_floor_liquidity_rises() {
        let low = tax_schedule(Money::from_dollars(75), Money::from_dollars(25));
        let middle = tax_schedule(Money::from_dollars(55), Money::from_dollars(45));
        let high = tax_schedule(Money::from_dollars(35), Money::from_dollars(65));
        assert_eq!(low.floor_liquidity_ratio_ppm, 250_000);
        assert_eq!(low.starvation_numerator, STARVATION_MAX_NUMERATOR);
        assert_eq!(
            low.inheritance_tax_basis_points,
            INHERITANCE_TAX_MAX_BASIS_POINTS
        );
        assert_eq!(middle.starvation_numerator, 60_969);
        assert_eq!(middle.inheritance_tax_basis_points, 1_100);
        assert_eq!(high.starvation_numerator, STARVATION_MIN_NUMERATOR);
        assert_eq!(
            high.inheritance_tax_basis_points,
            INHERITANCE_TAX_MIN_BASIS_POINTS
        );
        assert_eq!(
            tax_schedule(Money::from_dollars(100), Money::ZERO).inheritance_tax_basis_points,
            INHERITANCE_TAX_MAX_BASIS_POINTS
        );
        assert_eq!(
            tax_schedule(Money::ZERO, Money::from_dollars(100)).inheritance_tax_basis_points,
            INHERITANCE_TAX_MIN_BASIS_POINTS
        );
    }

    #[test]
    fn formulas_match_selected_thirty_hertz_rules() {
        assert_eq!(
            starvation_charge(
                Money::from_dollars(5),
                STARVATION_MAX_NUMERATOR,
                &mut FormulaRemainder::default()
            ),
            Money(481_330)
        );
        assert_eq!(
            starvation_charge(
                Money::from_dollars(5),
                STARVATION_MIN_NUMERATOR,
                &mut FormulaRemainder::default()
            ),
            Money(128_360)
        );
        assert_eq!(
            boost_charge(Money::from_dollars(5), &mut FormulaRemainder::default()),
            Money(6_667_500)
        );
        assert_eq!(
            boost_charge(Money::from_dollars(150), &mut FormulaRemainder::default()),
            Money(200_025_000)
        );
    }

    #[test]
    fn formula_remainder_preserves_long_run_fractional_value() {
        let worth = Money::from_dollars(5);
        let mut remainder = FormulaRemainder::default();
        let charged = (0..1_001).fold(Money::ZERO, |total, _| {
            total.checked_add(remainder.charge(worth, 1, 3))
        });
        assert_eq!(charged, Money(((u128::from(worth.0) * 1_001) / 3) as u64));
    }

    #[test]
    fn rake_rounds_down_and_sums_to_gross() {
        let split = split_rake(Money(5_000_000_001), 1_100);
        assert_eq!(split.inheritance_tax, Money(550_000_000));
        assert_eq!(split.platform_fee, Money(89_000_000));
        assert_eq!(split.payout, Money(4_361_000_001));
        assert_eq!(
            split
                .payout
                .checked_add(split.inheritance_tax)
                .checked_add(split.platform_fee),
            split.gross
        );
    }

    #[test]
    fn ledger_tracks_conservation() {
        let mut ledger = Ledger::default();
        let ticket = Tier::Casual.ticket();
        ledger.record_ticket(ticket);
        let coin = Tier::Casual.coin();
        ledger.transfer_to_floor(coin);
        assert!(ledger.is_conserved(ticket.checked_sub(coin), Money::ZERO));
        ledger.emit_floor(coin);
        assert!(ledger.is_conserved(ticket.checked_sub(coin), coin));
    }
}
