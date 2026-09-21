use std::{fmt, str::FromStr};

use serde::Serialize;

pub const NANOS_PER_DOLLAR: u64 = 1_000_000_000;
pub const MIN_EFFECTIVE_WORTH: Money = Money::from_dollars(5);
pub const TAX_NUMERATOR: u64 = 5;
pub const TAX_DENOMINATOR: u64 = 100_000;
pub const BOOST_NUMERATOR: u64 = 2_667;
pub const BOOST_DENOMINATOR: u64 = 2_000_000;
/// Share of a snake's worth paid out on cash-out, in basis points. There is currently no platform fee.
pub const PAYOUT_BASIS_POINTS: u16 = 10_000;
pub const PLATFORM_FEE_BASIS_POINTS: u16 = 0;
const _: () = assert!(PAYOUT_BASIS_POINTS as u32 + PLATFORM_FEE_BASIS_POINTS as u32 == 10_000);
pub const BALL: Money = Money(500_000_000);
pub const DENOMINATIONS: [Money; 1] = [BALL];

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

pub fn starvation_charge(worth: Money, remainder: &mut FormulaRemainder) -> Money {
    remainder.charge(worth, TAX_NUMERATOR, TAX_DENOMINATOR)
}

pub fn boost_charge(worth: Money, remainder: &mut FormulaRemainder) -> Money {
    remainder.charge(worth, BOOST_NUMERATOR, BOOST_DENOMINATOR)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RakeSplit {
    pub gross: Money,
    pub payout: Money,
    pub platform_fee: Money,
}

pub fn split_rake(gross: Money) -> RakeSplit {
    let platform_fee =
        Money(((u128::from(gross.0) * u128::from(PLATFORM_FEE_BASIS_POINTS)) / 10_000) as u64);
    let payout = gross.checked_sub(platform_fee);
    RakeSplit {
        gross,
        payout,
        platform_fee,
    }
}

#[derive(Debug, Clone, Default)]
pub struct Ledger {
    pub ticket_inflow: Money,
    pub treasury_seed: Money,
    pub pending_floor: Money,
    pub payouts: Money,
    pub platform_fees: Money,
}

impl Ledger {
    pub fn record_ticket(&mut self, ticket: Money) {
        self.ticket_inflow = self.ticket_inflow.checked_add(ticket);
    }

    pub fn seed_treasury(&mut self, amount: Money) {
        self.treasury_seed = self.treasury_seed.checked_add(amount);
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
        self.platform_fees = self.platform_fees.checked_add(split.platform_fee);
    }

    pub fn is_conserved(&self, live_worth: Money, floor_balls: Money) -> bool {
        let inflow = self.ticket_inflow.checked_add(self.treasury_seed);
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
    Disconnect,
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
    fn formulas_match_selected_thirty_hertz_rules() {
        assert_eq!(
            starvation_charge(Money::from_dollars(5), &mut FormulaRemainder::default()),
            Money(250_000)
        );
        assert_eq!(
            boost_charge(Money::from_dollars(5), &mut FormulaRemainder::default()),
            Money(6_667_500)
        );
        assert_eq!(
            starvation_charge(Money::from_dollars(150), &mut FormulaRemainder::default()),
            Money(7_500_000)
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
    fn cash_out_pays_the_full_worth_with_no_platform_fee() {
        for gross in [0, 1, 5_000_000_001, 123_456_789_012] {
            let split = split_rake(Money(gross));
            assert_eq!(split.payout, Money(gross));
            assert_eq!(split.platform_fee, Money::ZERO);
        }
    }

    #[test]
    fn rake_always_sums_to_gross() {
        let split = split_rake(Money(5_000_000_001));
        assert_eq!(split.payout.checked_add(split.platform_fee), split.gross);
    }

    #[test]
    fn ledger_tracks_conservation() {
        let mut ledger = Ledger::default();
        let ticket = Tier::Casual.ticket();
        ledger.record_ticket(ticket);
        ledger.transfer_to_floor(BALL);
        assert!(ledger.is_conserved(ticket.checked_sub(BALL), Money::ZERO));
        ledger.emit_floor(BALL);
        assert!(ledger.is_conserved(ticket.checked_sub(BALL), BALL));
    }
}
