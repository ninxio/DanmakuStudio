//! Deterministic fine-evaluation frontier and exact completed-assignment core.
//!
//! The caller must derive a complete pair-level relation inventory from the
//! complete raw coarse/fine window universe before calling this module. This
//! module never accepts raw windows or applies a Top-K cut: configured limits
//! reject the whole calculation instead of returning a partial answer.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

/// One full normalized score in fixed-point micros.
pub const FINE_FRONTIER_CONTRACT_VERSION: &str = "alignment-v2-adaptive-fine-frontier-v3";
pub const SCORE_MICROS_ONE: u32 = 1_000_000;
const CANCEL_CHECK_STRIDE: usize = 256;

/// A score or per-candidate upper bound in the inclusive range `0..=1_000_000`.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ScoreMicros(u32);

impl ScoreMicros {
    pub const ZERO: Self = Self(0);
    pub const ONE: Self = Self(SCORE_MICROS_ONE);

    pub fn new(value: u32) -> Result<Self, ScoreMicrosError> {
        if value <= SCORE_MICROS_ONE {
            Ok(Self(value))
        } else {
            Err(ScoreMicrosError { value })
        }
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

impl From<ScoreMicros> for u32 {
    fn from(value: ScoreMicros) -> Self {
        value.get()
    }
}

impl TryFrom<u32> for ScoreMicros {
    type Error = ScoreMicrosError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScoreMicrosError {
    pub value: u32,
}

/// Stable identity inside the complete coarse candidate inventory.
///
/// `pair_ordinal` owns the one-choice-at-most constraint. Every entry is a
/// pair-level relation alternative whose raw fine windows have already been
/// aggregated by the caller. Window-level evaluations must never be inserted
/// directly into this inventory.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FineCandidateId {
    pub pair_ordinal: u32,
    pub candidate_ordinal: u32,
}

/// A half-open physical interval `[start_ms, end_ms)`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PhysicalInterval {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// One canonical occupied axis in a physical media/track space.
///
/// Intervals must be sorted by `start_ms`, disjoint, and non-adjacent. Adjacent
/// or overlapping intervals must be merged by the caller before analysis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhysicalAxisOccupancy {
    pub space_ordinal: u32,
    /// Explicit opposite-side version cohort that is allowed to reuse this
    /// physical interval. `None` preserves exclusive occupancy. A non-zero
    /// ordinal is meaningful only when both candidates carry the same value;
    /// callers must prove that cohort members are distinct physical media.
    pub reuse_group_ordinal: Option<u32>,
    pub intervals: Vec<PhysicalInterval>,
}

/// Complete physical occupancy of one pair-level relation alternative.
///
/// The caller assigns the same `space_ordinal` wherever two occupied ranges on
/// the same axis role refer to the same physical media/track timeline. Source
/// and target roles remain distinct even when their ordinals are numerically
/// equal, matching the product's source-source / target-target conflict model.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PairPhysicalOccupancy {
    pub source: PhysicalAxisOccupancy,
    pub target: PhysicalAxisOccupancy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PhysicalAxisKind {
    Source,
    Target,
}

/// Fine-evaluation lifecycle. Only `Scored` is eligible for the completed
/// assignment and only `EvaluatedIneligible` has a proven zero contribution.
///
/// Every other state retains its coarse upper bound in the omitted-candidate
/// proof. In particular, a resource or infrastructure failure is not evidence
/// that the candidate is bad.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FineEvaluationState {
    Unresolved,
    Scored { score: ScoreMicros },
    EvaluatedIneligible,
    EvidenceBlocked,
    ResourceBlocked,
    InfrastructureFailed,
    Cancelled,
}

impl FineEvaluationState {
    fn is_open(self) -> bool {
        !matches!(self, Self::Scored { .. } | Self::EvaluatedIneligible)
    }

    fn is_unresolved(self) -> bool {
        matches!(self, Self::Unresolved)
    }

    fn is_blocked(self) -> bool {
        matches!(
            self,
            Self::EvidenceBlocked
                | Self::ResourceBlocked
                | Self::InfrastructureFailed
                | Self::Cancelled
        )
    }
}

/// One entry in the complete coarse universe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FineCandidate {
    pub id: FineCandidateId,
    pub coarse_upper_bound: ScoreMicros,
    /// `None` means occupancy is not known yet and is valid only before a
    /// candidate becomes `Scored`. A scored pair-level relation must provide
    /// canonical, non-empty occupancy for both axes. The optimistic omitted
    /// proof deliberately ignores all physical conflicts, which is safe.
    pub physical_occupancy: Option<PairPhysicalOccupancy>,
    pub state: FineEvaluationState,
}

/// Complete inventory wrapper. Construction does not truncate or rank entries.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FineCandidateInventory {
    pub candidates: Vec<FineCandidate>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FineFrontierLimits {
    /// Hard admission limit for the complete candidate inventory.
    pub max_candidates: usize,
    /// Hard number of exact-search nodes entered.
    pub max_search_states: u64,
    /// Hard number of exact-search edges considered, including rejected ones.
    pub max_search_expansions: u64,
    /// Hard number of canonical interval-pair comparisons performed by the
    /// exact conflict checker.
    pub max_interval_comparisons: u64,
    /// Hard interval count for either axis of one relation alternative.
    pub max_intervals_per_axis: usize,
    /// Hard interval count across the complete inventory, including open
    /// candidates which already carry known occupancy.
    pub max_total_intervals: usize,
    /// Maximum number of candidates scheduled in one refinement batch.
    pub refinement_batch_size: usize,
}

impl Default for FineFrontierLimits {
    fn default() -> Self {
        Self {
            max_candidates: 32_768,
            max_search_states: 2_000_000,
            max_search_expansions: 8_000_000,
            max_interval_comparisons: 32_000_000,
            max_intervals_per_axis: 4_096,
            max_total_intervals: 262_144,
            refinement_batch_size: 16,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FineFrontierConfig {
    /// Absolute assignment-score margin. Assignment totals are sums of
    /// fixed-point candidate micros and therefore use `u64`.
    pub resolution_margin_micros: u64,
    /// Two occupied ranges conflict only when their overlap is strictly
    /// greater than this tolerance.
    pub overlap_tolerance_ms: u64,
    pub limits: FineFrontierLimits,
}

impl Default for FineFrontierConfig {
    fn default() -> Self {
        Self {
            resolution_margin_micros: 0,
            overlap_tolerance_ms: 250,
            limits: FineFrontierLimits::default(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExactAssignment {
    /// Stable IDs sorted by pair ordinal, independent of inventory order.
    pub candidate_ids: Vec<FineCandidateId>,
    pub total_score_micros: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptimisticOmittedAssignment {
    /// Includes scored support candidates as well as at least one open item.
    pub candidate_ids: Vec<FineCandidateId>,
    /// Uses final scores for `Scored` items and coarse upper bounds for open
    /// items. Physical conflicts are deliberately ignored, so this cannot
    /// underestimate the best assignment containing an omitted item.
    pub total_upper_bound_micros: u64,
    pub open_candidate_ids: Vec<FineCandidateId>,
    pub unresolved_candidate_ids: Vec<FineCandidateId>,
    pub blocked_candidate_ids: Vec<FineCandidateId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefinementBatch {
    /// Unresolved candidates selected by the current optimistic competitor,
    /// ordered by upper bound descending and then stable ID ascending.
    pub candidate_ids: Vec<FineCandidateId>,
    /// Explicitly reports scheduling deferral; the inventory is never cut.
    pub deferred_candidate_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExactSearchStats {
    pub states_visited: u64,
    pub expansions_considered: u64,
    pub interval_comparisons: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResolutionProof {
    pub beats_runner_up_with_margin: bool,
    pub beats_optimistic_omitted_with_margin: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FineFrontierState {
    /// At least one unresolved item is scheduled for deterministic refinement.
    Pending,
    /// A non-empty completed assignment beats every retained competitor.
    Resolved,
    /// The inventory is empty or every retained item is proven ineligible.
    NoEligibleCandidate,
    /// The proof cannot close and no unresolved item can currently be refined,
    /// for example because evidence or resources are blocked.
    Unresolved,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FineFrontierOutcome {
    pub best_completed: ExactAssignment,
    pub runner_up_completed: Option<ExactAssignment>,
    pub optimistic_omitted: Option<OptimisticOmittedAssignment>,
    pub next_refinement: RefinementBatch,
    pub proof: ResolutionProof,
    pub state: FineFrontierState,
    /// Convenience mirror for existing callers. It is true exactly when
    /// `state == FineFrontierState::Resolved`.
    pub resolved: bool,
    pub search: ExactSearchStats,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchLimitKind {
    States,
    Expansions,
    IntervalComparisons,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntervalLimitKind {
    PerAxis,
    TotalInventory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FineFrontierError {
    Cancelled,
    InvalidLimit {
        name: &'static str,
    },
    CandidateLimitExceeded {
        candidate_count: usize,
        max_candidates: usize,
    },
    DuplicateCandidateId {
        id: FineCandidateId,
    },
    InvalidPhysicalInterval {
        id: FineCandidateId,
        space_ordinal: u32,
        start_ms: u64,
        end_ms: u64,
    },
    FineScoreExceedsCoarseUpper {
        id: FineCandidateId,
        fine_score: ScoreMicros,
        coarse_upper_bound: ScoreMicros,
    },
    MissingScoredPhysicalOccupancy {
        id: FineCandidateId,
    },
    EmptyPhysicalAxisOccupancy {
        id: FineCandidateId,
        axis: PhysicalAxisKind,
        space_ordinal: u32,
    },
    InvalidReuseGroupOrdinal {
        id: FineCandidateId,
        axis: PhysicalAxisKind,
    },
    NonCanonicalPhysicalIntervals {
        id: FineCandidateId,
        axis: PhysicalAxisKind,
        space_ordinal: u32,
        previous: PhysicalInterval,
        current: PhysicalInterval,
    },
    IntervalLimitExceeded {
        kind: IntervalLimitKind,
        id: Option<FineCandidateId>,
        axis: Option<PhysicalAxisKind>,
        interval_count: usize,
        limit: usize,
    },
    SearchLimitExceeded {
        kind: SearchLimitKind,
        limit: u64,
        search: ExactSearchStats,
    },
    ScoreTotalOverflow,
}

/// Analyze completed candidates, prove whether omitted candidates can still
/// win, and select the next deterministic fine-evaluation batch.
///
/// Any hard-limit error invalidates the whole analysis. No partial best or
/// partial frontier is returned.
pub fn analyze_fine_frontier(
    inventory: &FineCandidateInventory,
    config: FineFrontierConfig,
) -> Result<FineFrontierOutcome, FineFrontierError> {
    analyze_fine_frontier_with_cancel(inventory, config, None)
}

/// Cancellation-aware variant. A raised flag invalidates the whole analysis;
/// this function never returns a partial assignment or partial frontier.
pub fn analyze_fine_frontier_with_cancel(
    inventory: &FineCandidateInventory,
    config: FineFrontierConfig,
    cancel: Option<&AtomicBool>,
) -> Result<FineFrontierOutcome, FineFrontierError> {
    check_cancel(cancel)?;
    validate_config(config)?;
    validate_inventory(inventory, config.limits, cancel)?;

    let ordered_indices = ordered_candidate_indices(inventory, cancel)?;
    let (best_completed, runner_up_completed, search) =
        find_exact_completed_assignments(inventory, &ordered_indices, config, cancel)?;
    check_cancel(cancel)?;
    let optimistic_omitted =
        find_optimistic_omitted_assignment(inventory, &ordered_indices, cancel)?;
    let mut next_refinement = build_refinement_batch(
        inventory,
        optimistic_omitted.as_ref(),
        config.limits.refinement_batch_size,
        cancel,
    )?;

    let beats_runner_up_with_margin = runner_up_completed.as_ref().is_none_or(|runner| {
        strictly_beats_with_margin(
            best_completed.total_score_micros,
            runner.total_score_micros,
            config.resolution_margin_micros,
        )
    });
    let beats_optimistic_omitted_with_margin = optimistic_omitted.as_ref().is_none_or(|omitted| {
        strictly_beats_with_margin(
            best_completed.total_score_micros,
            omitted.total_upper_bound_micros,
            config.resolution_margin_micros,
        )
    });
    let proof = ResolutionProof {
        beats_runner_up_with_margin,
        beats_optimistic_omitted_with_margin,
    };
    let mut has_potentially_eligible_candidate = false;
    for (index, candidate) in inventory.candidates.iter().enumerate() {
        check_cancel_periodically(cancel, index)?;
        if !matches!(candidate.state, FineEvaluationState::EvaluatedIneligible) {
            has_potentially_eligible_candidate = true;
            break;
        }
    }
    let state = if !has_potentially_eligible_candidate {
        FineFrontierState::NoEligibleCandidate
    } else if proof.beats_runner_up_with_margin
        && proof.beats_optimistic_omitted_with_margin
        && !best_completed.candidate_ids.is_empty()
    {
        FineFrontierState::Resolved
    } else if !next_refinement.candidate_ids.is_empty() {
        FineFrontierState::Pending
    } else {
        FineFrontierState::Unresolved
    };

    // The optimistic batch is computed before the proof state so Pending can
    // schedule work deterministically. Once the proof has already closed,
    // however, that batch is stale and must not escape as executable work.
    if matches!(
        state,
        FineFrontierState::Resolved | FineFrontierState::NoEligibleCandidate
    ) {
        next_refinement = RefinementBatch {
            candidate_ids: Vec::new(),
            deferred_candidate_count: 0,
        };
    }

    check_cancel(cancel)?;
    Ok(FineFrontierOutcome {
        best_completed,
        runner_up_completed,
        optimistic_omitted,
        next_refinement,
        proof,
        state,
        resolved: state == FineFrontierState::Resolved,
        search,
    })
}

fn check_cancel(cancel: Option<&AtomicBool>) -> Result<(), FineFrontierError> {
    if cancel.is_some_and(|flag| flag.load(AtomicOrdering::Relaxed)) {
        Err(FineFrontierError::Cancelled)
    } else {
        Ok(())
    }
}

fn check_cancel_periodically(
    cancel: Option<&AtomicBool>,
    item_index: usize,
) -> Result<(), FineFrontierError> {
    if item_index.is_multiple_of(CANCEL_CHECK_STRIDE) {
        check_cancel(cancel)?;
    }
    Ok(())
}

fn validate_config(config: FineFrontierConfig) -> Result<(), FineFrontierError> {
    for (name, value) in [
        ("max_candidates", config.limits.max_candidates),
        (
            "max_intervals_per_axis",
            config.limits.max_intervals_per_axis,
        ),
        ("max_total_intervals", config.limits.max_total_intervals),
        ("refinement_batch_size", config.limits.refinement_batch_size),
    ] {
        if value == 0 {
            return Err(FineFrontierError::InvalidLimit { name });
        }
    }
    for (name, value) in [
        ("max_search_states", config.limits.max_search_states),
        ("max_search_expansions", config.limits.max_search_expansions),
        (
            "max_interval_comparisons",
            config.limits.max_interval_comparisons,
        ),
    ] {
        if value == 0 {
            return Err(FineFrontierError::InvalidLimit { name });
        }
    }
    Ok(())
}

fn validate_inventory(
    inventory: &FineCandidateInventory,
    limits: FineFrontierLimits,
    cancel: Option<&AtomicBool>,
) -> Result<(), FineFrontierError> {
    if inventory.candidates.len() > limits.max_candidates {
        return Err(FineFrontierError::CandidateLimitExceeded {
            candidate_count: inventory.candidates.len(),
            max_candidates: limits.max_candidates,
        });
    }

    let mut ids = BTreeSet::new();
    let mut total_intervals = 0_usize;
    for (candidate_index, candidate) in inventory.candidates.iter().enumerate() {
        check_cancel_periodically(cancel, candidate_index)?;
        if !ids.insert(candidate.id) {
            return Err(FineFrontierError::DuplicateCandidateId { id: candidate.id });
        }
        let is_scored = matches!(candidate.state, FineEvaluationState::Scored { .. });
        if let FineEvaluationState::Scored { score } = candidate.state {
            if score > candidate.coarse_upper_bound {
                return Err(FineFrontierError::FineScoreExceedsCoarseUpper {
                    id: candidate.id,
                    fine_score: score,
                    coarse_upper_bound: candidate.coarse_upper_bound,
                });
            }
        }
        if is_scored && candidate.physical_occupancy.is_none() {
            return Err(FineFrontierError::MissingScoredPhysicalOccupancy { id: candidate.id });
        }
        if let Some(occupancy) = &candidate.physical_occupancy {
            validate_axis_occupancy(
                candidate.id,
                PhysicalAxisKind::Source,
                &occupancy.source,
                limits,
                &mut total_intervals,
                cancel,
            )?;
            validate_axis_occupancy(
                candidate.id,
                PhysicalAxisKind::Target,
                &occupancy.target,
                limits,
                &mut total_intervals,
                cancel,
            )?;
        }
    }
    Ok(())
}

fn validate_axis_occupancy(
    id: FineCandidateId,
    axis: PhysicalAxisKind,
    occupancy: &PhysicalAxisOccupancy,
    limits: FineFrontierLimits,
    total_intervals: &mut usize,
    cancel: Option<&AtomicBool>,
) -> Result<(), FineFrontierError> {
    if occupancy.reuse_group_ordinal == Some(0) {
        return Err(FineFrontierError::InvalidReuseGroupOrdinal { id, axis });
    }
    if occupancy.intervals.is_empty() {
        return Err(FineFrontierError::EmptyPhysicalAxisOccupancy {
            id,
            axis,
            space_ordinal: occupancy.space_ordinal,
        });
    }
    if occupancy.intervals.len() > limits.max_intervals_per_axis {
        return Err(FineFrontierError::IntervalLimitExceeded {
            kind: IntervalLimitKind::PerAxis,
            id: Some(id),
            axis: Some(axis),
            interval_count: occupancy.intervals.len(),
            limit: limits.max_intervals_per_axis,
        });
    }
    *total_intervals = total_intervals
        .checked_add(occupancy.intervals.len())
        .unwrap_or(usize::MAX);
    if *total_intervals > limits.max_total_intervals {
        return Err(FineFrontierError::IntervalLimitExceeded {
            kind: IntervalLimitKind::TotalInventory,
            id: None,
            axis: None,
            interval_count: *total_intervals,
            limit: limits.max_total_intervals,
        });
    }

    let mut previous = None::<PhysicalInterval>;
    for (interval_index, interval) in occupancy.intervals.iter().enumerate() {
        check_cancel_periodically(cancel, interval_index)?;
        if interval.start_ms >= interval.end_ms {
            return Err(FineFrontierError::InvalidPhysicalInterval {
                id,
                space_ordinal: occupancy.space_ordinal,
                start_ms: interval.start_ms,
                end_ms: interval.end_ms,
            });
        }
        if let Some(previous_interval) = previous {
            if previous_interval.end_ms >= interval.start_ms {
                return Err(FineFrontierError::NonCanonicalPhysicalIntervals {
                    id,
                    axis,
                    space_ordinal: occupancy.space_ordinal,
                    previous: previous_interval,
                    current: *interval,
                });
            }
        }
        previous = Some(*interval);
    }
    Ok(())
}

fn ordered_candidate_indices(
    inventory: &FineCandidateInventory,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<usize>, FineFrontierError> {
    let mut indices = Vec::with_capacity(inventory.candidates.len());
    for index in 0..inventory.candidates.len() {
        check_cancel_periodically(cancel, index)?;
        indices.push(index);
    }
    check_cancel(cancel)?;
    indices.sort_unstable_by_key(|index| inventory.candidates[*index].id);
    check_cancel(cancel)?;
    Ok(indices)
}

fn strictly_beats_with_margin(best: u64, competitor: u64, margin: u64) -> bool {
    competitor
        .checked_add(margin)
        .is_some_and(|threshold| best > threshold)
}

#[derive(Clone, Copy)]
struct ExactChoice {
    candidate_index: Option<usize>,
    score_micros: u64,
}

struct ExactPairChoices {
    choices: Vec<ExactChoice>,
    max_score_micros: u64,
}

#[derive(Default)]
struct ExactTopTwo {
    best: Option<ExactAssignment>,
    runner_up: Option<ExactAssignment>,
}

impl ExactTopTwo {
    fn consider(&mut self, candidate: ExactAssignment) {
        if self
            .best
            .as_ref()
            .is_none_or(|best| assignment_is_better(&candidate, best))
        {
            if self
                .best
                .as_ref()
                .is_some_and(|best| best.candidate_ids != candidate.candidate_ids)
            {
                self.runner_up = self.best.take();
            }
            self.best = Some(candidate);
            return;
        }

        if self
            .best
            .as_ref()
            .is_some_and(|best| best.candidate_ids == candidate.candidate_ids)
        {
            return;
        }
        if self
            .runner_up
            .as_ref()
            .is_none_or(|runner| assignment_is_better(&candidate, runner))
        {
            self.runner_up = Some(candidate);
        }
    }
}

fn assignment_is_better(left: &ExactAssignment, right: &ExactAssignment) -> bool {
    left.total_score_micros > right.total_score_micros
        || (left.total_score_micros == right.total_score_micros
            && left.candidate_ids < right.candidate_ids)
}

struct SearchBudget<'a> {
    states_visited: u64,
    expansions_considered: u64,
    interval_comparisons: u64,
    max_states: u64,
    max_expansions: u64,
    max_interval_comparisons: u64,
    cancel: Option<&'a AtomicBool>,
}

impl SearchBudget<'_> {
    fn enter_state(&mut self) -> Result<(), FineFrontierError> {
        if self
            .states_visited
            .is_multiple_of(CANCEL_CHECK_STRIDE as u64)
        {
            check_cancel(self.cancel)?;
        }
        if self.states_visited >= self.max_states {
            return Err(FineFrontierError::SearchLimitExceeded {
                kind: SearchLimitKind::States,
                limit: self.max_states,
                search: self.stats(),
            });
        }
        self.states_visited += 1;
        Ok(())
    }

    fn consume_expansion(&mut self) -> Result<(), FineFrontierError> {
        if self
            .expansions_considered
            .is_multiple_of(CANCEL_CHECK_STRIDE as u64)
        {
            check_cancel(self.cancel)?;
        }
        if self.expansions_considered >= self.max_expansions {
            return Err(FineFrontierError::SearchLimitExceeded {
                kind: SearchLimitKind::Expansions,
                limit: self.max_expansions,
                search: self.stats(),
            });
        }
        self.expansions_considered += 1;
        Ok(())
    }

    fn consume_interval_comparison(&mut self) -> Result<(), FineFrontierError> {
        if self
            .interval_comparisons
            .is_multiple_of(CANCEL_CHECK_STRIDE as u64)
        {
            check_cancel(self.cancel)?;
        }
        if self.interval_comparisons >= self.max_interval_comparisons {
            return Err(FineFrontierError::SearchLimitExceeded {
                kind: SearchLimitKind::IntervalComparisons,
                limit: self.max_interval_comparisons,
                search: self.stats(),
            });
        }
        self.interval_comparisons += 1;
        Ok(())
    }

    fn stats(&self) -> ExactSearchStats {
        ExactSearchStats {
            states_visited: self.states_visited,
            expansions_considered: self.expansions_considered,
            interval_comparisons: self.interval_comparisons,
        }
    }
}

fn find_exact_completed_assignments(
    inventory: &FineCandidateInventory,
    ordered_indices: &[usize],
    config: FineFrontierConfig,
    cancel: Option<&AtomicBool>,
) -> Result<(ExactAssignment, Option<ExactAssignment>, ExactSearchStats), FineFrontierError> {
    let mut pair_candidates = BTreeMap::<u32, Vec<usize>>::new();
    for (ordered_index, index) in ordered_indices.iter().enumerate() {
        check_cancel_periodically(cancel, ordered_index)?;
        let candidate = &inventory.candidates[*index];
        if matches!(candidate.state, FineEvaluationState::Scored { .. }) {
            pair_candidates
                .entry(candidate.id.pair_ordinal)
                .or_default()
                .push(*index);
        }
    }

    let mut pairs = Vec::with_capacity(pair_candidates.len());
    for (pair_index, (_, mut indices)) in pair_candidates.into_iter().enumerate() {
        check_cancel_periodically(cancel, pair_index)?;
        indices.sort_unstable_by(|left, right| {
            let left_candidate = &inventory.candidates[*left];
            let right_candidate = &inventory.candidates[*right];
            let left_score = scored_value(left_candidate);
            let right_score = scored_value(right_candidate);
            right_score
                .cmp(&left_score)
                .then_with(|| left_candidate.id.cmp(&right_candidate.id))
        });
        let max_score_micros = indices
            .first()
            .map(|index| scored_value(&inventory.candidates[*index]))
            .unwrap_or(0);
        let mut choices = indices
            .into_iter()
            .map(|candidate_index| ExactChoice {
                candidate_index: Some(candidate_index),
                score_micros: scored_value(&inventory.candidates[candidate_index]),
            })
            .collect::<Vec<_>>();
        // Leaving a pair unmatched is an explicit exact-search choice.
        choices.push(ExactChoice {
            candidate_index: None,
            score_micros: 0,
        });
        pairs.push(ExactPairChoices {
            choices,
            max_score_micros,
        });
    }

    let mut suffix_upper = vec![0_u64; pairs.len() + 1];
    for (offset, index) in (0..pairs.len()).rev().enumerate() {
        check_cancel_periodically(cancel, offset)?;
        suffix_upper[index] = suffix_upper[index + 1]
            .checked_add(pairs[index].max_score_micros)
            .ok_or(FineFrontierError::ScoreTotalOverflow)?;
    }

    let mut budget = SearchBudget {
        states_visited: 0,
        expansions_considered: 0,
        interval_comparisons: 0,
        max_states: config.limits.max_search_states,
        max_expansions: config.limits.max_search_expansions,
        max_interval_comparisons: config.limits.max_interval_comparisons,
        cancel,
    };
    let mut top_two = ExactTopTwo::default();
    let mut selected_indices = Vec::with_capacity(pairs.len());
    exact_search_dfs(
        inventory,
        &pairs,
        &suffix_upper,
        0,
        0,
        &mut selected_indices,
        &mut top_two,
        &mut budget,
        config.overlap_tolerance_ms,
    )?;

    let best = top_two.best.unwrap_or(ExactAssignment {
        candidate_ids: Vec::new(),
        total_score_micros: 0,
    });
    Ok((best, top_two.runner_up, budget.stats()))
}

#[allow(clippy::too_many_arguments)]
fn exact_search_dfs(
    inventory: &FineCandidateInventory,
    pairs: &[ExactPairChoices],
    suffix_upper: &[u64],
    pair_index: usize,
    current_score: u64,
    selected_indices: &mut Vec<usize>,
    top_two: &mut ExactTopTwo,
    budget: &mut SearchBudget<'_>,
    overlap_tolerance_ms: u64,
) -> Result<(), FineFrontierError> {
    budget.enter_state()?;

    let optimistic_score = current_score
        .checked_add(suffix_upper[pair_index])
        .ok_or(FineFrontierError::ScoreTotalOverflow)?;
    if top_two
        .runner_up
        .as_ref()
        .is_some_and(|runner| optimistic_score < runner.total_score_micros)
    {
        return Ok(());
    }

    if pair_index == pairs.len() {
        let candidate_ids = selected_indices
            .iter()
            .map(|index| inventory.candidates[*index].id)
            .collect();
        top_two.consider(ExactAssignment {
            candidate_ids,
            total_score_micros: current_score,
        });
        return Ok(());
    }

    for choice in &pairs[pair_index].choices {
        budget.consume_expansion()?;
        if let Some(candidate_index) = choice.candidate_index {
            if conflicts_with_selected(
                inventory,
                candidate_index,
                selected_indices,
                overlap_tolerance_ms,
                budget,
            )? {
                continue;
            }
            let next_score = current_score
                .checked_add(choice.score_micros)
                .ok_or(FineFrontierError::ScoreTotalOverflow)?;
            selected_indices.push(candidate_index);
            exact_search_dfs(
                inventory,
                pairs,
                suffix_upper,
                pair_index + 1,
                next_score,
                selected_indices,
                top_two,
                budget,
                overlap_tolerance_ms,
            )?;
            selected_indices.pop();
        } else {
            exact_search_dfs(
                inventory,
                pairs,
                suffix_upper,
                pair_index + 1,
                current_score,
                selected_indices,
                top_two,
                budget,
                overlap_tolerance_ms,
            )?;
        }
    }
    Ok(())
}

fn scored_value(candidate: &FineCandidate) -> u64 {
    match candidate.state {
        FineEvaluationState::Scored { score } => u64::from(score.get()),
        _ => 0,
    }
}

fn conflicts_with_selected(
    inventory: &FineCandidateInventory,
    candidate_index: usize,
    selected_indices: &[usize],
    overlap_tolerance_ms: u64,
    budget: &mut SearchBudget<'_>,
) -> Result<bool, FineFrontierError> {
    for selected_index in selected_indices {
        if physical_occupancy_conflicts(
            &inventory.candidates[candidate_index],
            &inventory.candidates[*selected_index],
            overlap_tolerance_ms,
            budget,
        )? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn physical_occupancy_conflicts(
    left: &FineCandidate,
    right: &FineCandidate,
    overlap_tolerance_ms: u64,
    budget: &mut SearchBudget<'_>,
) -> Result<bool, FineFrontierError> {
    let (Some(left_occupancy), Some(right_occupancy)) =
        (&left.physical_occupancy, &right.physical_occupancy)
    else {
        return Ok(false);
    };

    for (left_axis, right_axis) in [
        (&left_occupancy.source, &right_occupancy.source),
        (&left_occupancy.target, &right_occupancy.target),
    ] {
        if left_axis.space_ordinal == right_axis.space_ordinal
            && !axis_reuse_is_explicitly_shared(left_axis, right_axis)
            && canonical_intervals_conflict(
                &left_axis.intervals,
                &right_axis.intervals,
                overlap_tolerance_ms,
                budget,
            )?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn axis_reuse_is_explicitly_shared(
    left: &PhysicalAxisOccupancy,
    right: &PhysicalAxisOccupancy,
) -> bool {
    left.reuse_group_ordinal
        .is_some_and(|group| right.reuse_group_ordinal == Some(group))
}

fn canonical_intervals_conflict(
    left: &[PhysicalInterval],
    right: &[PhysicalInterval],
    overlap_tolerance_ms: u64,
    budget: &mut SearchBudget<'_>,
) -> Result<bool, FineFrontierError> {
    let mut left_index = 0_usize;
    let mut right_index = 0_usize;
    while left_index < left.len() && right_index < right.len() {
        budget.consume_interval_comparison()?;
        let left_interval = left[left_index];
        let right_interval = right[right_index];
        let overlap_start = left_interval.start_ms.max(right_interval.start_ms);
        let overlap_end = left_interval.end_ms.min(right_interval.end_ms);
        if overlap_end.saturating_sub(overlap_start) > overlap_tolerance_ms {
            return Ok(true);
        }

        match left_interval.end_ms.cmp(&right_interval.end_ms) {
            Ordering::Less => left_index += 1,
            Ordering::Greater => right_index += 1,
            Ordering::Equal => {
                left_index += 1;
                right_index += 1;
            }
        }
    }
    Ok(false)
}

#[derive(Clone, Copy)]
struct OptimisticOption {
    candidate_index: Option<usize>,
    contribution_micros: u64,
    is_open: bool,
}

struct OptimisticPairSummary {
    options: Vec<OptimisticOption>,
    best_any_micros: u64,
    best_open_micros: Option<u64>,
}

#[derive(Clone, Copy)]
struct OptimisticDecision {
    candidate_index: Option<usize>,
    next_requires_open: usize,
}

#[derive(Clone, Copy)]
struct OptimisticPlanCandidate {
    total_upper_bound_micros: u64,
    decision: OptimisticDecision,
    sequence_is_empty: bool,
}

#[derive(Clone, Copy)]
struct OptimisticSuffixState {
    total_upper_bound_micros: u64,
    sequence_is_empty: bool,
    /// Relative lexicographic rank among the two states at the same suffix.
    /// Equal sequences intentionally receive the same rank.
    sequence_rank: u8,
}

fn find_optimistic_omitted_assignment(
    inventory: &FineCandidateInventory,
    ordered_indices: &[usize],
    cancel: Option<&AtomicBool>,
) -> Result<Option<OptimisticOmittedAssignment>, FineFrontierError> {
    let pairs = build_optimistic_pair_summaries(inventory, ordered_indices, cancel)?;

    // Ignoring interval conflicts leaves independent pair choices. The best
    // score without the omitted-item requirement is the sum of per-pair
    // best-any scores. Forcing at least one open item costs the smallest
    // per-pair (best-any - best-open) loss. This is a safe upper bound because
    // it retains only the pair constraint and never invents a tighter physical
    // conflict. Both passes are linear in candidates plus pairs.
    let mut best_any_total = 0_u64;
    let mut minimum_forced_open_loss = None::<u64>;
    for (pair_index, pair) in pairs.iter().enumerate() {
        check_cancel_periodically(cancel, pair_index)?;
        best_any_total = best_any_total
            .checked_add(pair.best_any_micros)
            .ok_or(FineFrontierError::ScoreTotalOverflow)?;
        if let Some(best_open_micros) = pair.best_open_micros {
            let loss = pair.best_any_micros - best_open_micros;
            minimum_forced_open_loss =
                Some(minimum_forced_open_loss.map_or(loss, |current| current.min(loss)));
        }
    }
    let Some(minimum_forced_open_loss) = minimum_forced_open_loss else {
        return Ok(None);
    };
    let expected_upper_bound = best_any_total - minimum_forced_open_loss;

    // Backward two-state reconstruction preserves the canonical lexicographic
    // tie-break without cloning a growing prefix. Each state stores only one
    // decision/backpointer, so memory is O(pair_count), not O(pair_count^2).
    let (optimistic_candidate_indices, total_upper_bound_micros) =
        reconstruct_canonical_optimistic_assignment(inventory, &pairs, cancel)?;
    debug_assert_eq!(total_upper_bound_micros, expected_upper_bound);

    let mut candidate_ids = Vec::with_capacity(optimistic_candidate_indices.len());
    let mut open_candidate_ids = Vec::new();
    let mut unresolved_candidate_ids = Vec::new();
    let mut blocked_candidate_ids = Vec::new();
    for (position, index) in optimistic_candidate_indices.iter().enumerate() {
        check_cancel_periodically(cancel, position)?;
        let candidate = &inventory.candidates[*index];
        candidate_ids.push(candidate.id);
        if candidate.state.is_open() {
            open_candidate_ids.push(candidate.id);
        }
        if candidate.state.is_unresolved() {
            unresolved_candidate_ids.push(candidate.id);
        }
        if candidate.state.is_blocked() {
            blocked_candidate_ids.push(candidate.id);
        }
    }

    Ok(Some(OptimisticOmittedAssignment {
        candidate_ids,
        total_upper_bound_micros,
        open_candidate_ids,
        unresolved_candidate_ids,
        blocked_candidate_ids,
    }))
}

fn build_optimistic_pair_summaries(
    inventory: &FineCandidateInventory,
    ordered_indices: &[usize],
    cancel: Option<&AtomicBool>,
) -> Result<Vec<OptimisticPairSummary>, FineFrontierError> {
    let mut pairs = Vec::<OptimisticPairSummary>::new();
    let mut current_pair_ordinal = None;

    for (ordered_index, index) in ordered_indices.iter().enumerate() {
        check_cancel_periodically(cancel, ordered_index)?;
        let candidate = &inventory.candidates[*index];
        if matches!(candidate.state, FineEvaluationState::EvaluatedIneligible) {
            continue;
        }
        if current_pair_ordinal != Some(candidate.id.pair_ordinal) {
            current_pair_ordinal = Some(candidate.id.pair_ordinal);
            pairs.push(OptimisticPairSummary {
                options: vec![OptimisticOption {
                    candidate_index: None,
                    contribution_micros: 0,
                    is_open: false,
                }],
                best_any_micros: 0,
                best_open_micros: None,
            });
        }

        let is_open = candidate.state.is_open();
        let contribution_micros = match candidate.state {
            FineEvaluationState::Scored { score } => u64::from(score.get()),
            FineEvaluationState::EvaluatedIneligible => unreachable!("filtered above"),
            _ => u64::from(candidate.coarse_upper_bound.get()),
        };
        let pair = pairs.last_mut().expect("pair was inserted above");
        pair.options.push(OptimisticOption {
            candidate_index: Some(*index),
            contribution_micros,
            is_open,
        });
        pair.best_any_micros = pair.best_any_micros.max(contribution_micros);
        if is_open {
            pair.best_open_micros = Some(
                pair.best_open_micros
                    .map_or(contribution_micros, |current| {
                        current.max(contribution_micros)
                    }),
            );
        }
    }
    Ok(pairs)
}

fn reconstruct_canonical_optimistic_assignment(
    inventory: &FineCandidateInventory,
    pairs: &[OptimisticPairSummary],
    cancel: Option<&AtomicBool>,
) -> Result<(Vec<usize>, u64), FineFrontierError> {
    let mut decisions = vec![[None::<OptimisticDecision>; 2]; pairs.len()];
    let mut suffix_states = [
        Some(OptimisticSuffixState {
            total_upper_bound_micros: 0,
            sequence_is_empty: true,
            sequence_rank: 0,
        }),
        None,
    ];

    for (pair_offset, pair_index) in (0..pairs.len()).rev().enumerate() {
        check_cancel_periodically(cancel, pair_offset)?;
        let mut chosen = [None::<OptimisticPlanCandidate>; 2];
        for (requires_open, chosen_plan) in chosen.iter_mut().enumerate() {
            for (option_index, option) in pairs[pair_index].options.iter().enumerate() {
                check_cancel_periodically(cancel, option_index)?;
                let next_requires_open = usize::from(requires_open == 1 && !option.is_open);
                let Some(next_state) = suffix_states[next_requires_open] else {
                    continue;
                };
                let total_upper_bound_micros = option
                    .contribution_micros
                    .checked_add(next_state.total_upper_bound_micros)
                    .ok_or(FineFrontierError::ScoreTotalOverflow)?;
                let plan = OptimisticPlanCandidate {
                    total_upper_bound_micros,
                    decision: OptimisticDecision {
                        candidate_index: option.candidate_index,
                        next_requires_open,
                    },
                    sequence_is_empty: option.candidate_index.is_none()
                        && next_state.sequence_is_empty,
                };
                if chosen_plan.is_none_or(|current| {
                    optimistic_plan_is_better(inventory, plan, current, suffix_states)
                }) {
                    *chosen_plan = Some(plan);
                }
            }
        }

        let ranks = canonical_plan_ranks(inventory, chosen, suffix_states);
        let mut current_states = [None::<OptimisticSuffixState>; 2];
        for requires_open in 0..=1 {
            if let Some(plan) = chosen[requires_open] {
                decisions[pair_index][requires_open] = Some(plan.decision);
                current_states[requires_open] = Some(OptimisticSuffixState {
                    total_upper_bound_micros: plan.total_upper_bound_micros,
                    sequence_is_empty: plan.sequence_is_empty,
                    sequence_rank: ranks[requires_open],
                });
            }
        }
        suffix_states = current_states;
    }

    let optimistic = suffix_states[1].expect("caller proved at least one open candidate");
    let mut candidate_indices = Vec::with_capacity(pairs.len());
    let mut requires_open = 1_usize;
    for (pair_index, pair_decisions) in decisions.into_iter().enumerate() {
        check_cancel_periodically(cancel, pair_index)?;
        let decision = pair_decisions[requires_open]
            .expect("canonical optimistic state must have a complete backpointer chain");
        if let Some(candidate_index) = decision.candidate_index {
            candidate_indices.push(candidate_index);
        }
        requires_open = decision.next_requires_open;
    }
    debug_assert_eq!(requires_open, 0);
    Ok((candidate_indices, optimistic.total_upper_bound_micros))
}

fn optimistic_plan_is_better(
    inventory: &FineCandidateInventory,
    left: OptimisticPlanCandidate,
    right: OptimisticPlanCandidate,
    suffix_states: [Option<OptimisticSuffixState>; 2],
) -> bool {
    left.total_upper_bound_micros > right.total_upper_bound_micros
        || (left.total_upper_bound_micros == right.total_upper_bound_micros
            && compare_optimistic_plan_sequences(inventory, left, right, suffix_states)
                == Ordering::Less)
}

fn canonical_plan_ranks(
    inventory: &FineCandidateInventory,
    plans: [Option<OptimisticPlanCandidate>; 2],
    suffix_states: [Option<OptimisticSuffixState>; 2],
) -> [u8; 2] {
    let (Some(left), Some(right)) = (plans[0], plans[1]) else {
        return [0, 0];
    };
    match compare_optimistic_plan_sequences(inventory, left, right, suffix_states) {
        Ordering::Less => [0, 1],
        Ordering::Equal => [0, 0],
        Ordering::Greater => [1, 0],
    }
}

fn compare_optimistic_plan_sequences(
    inventory: &FineCandidateInventory,
    left: OptimisticPlanCandidate,
    right: OptimisticPlanCandidate,
    suffix_states: [Option<OptimisticSuffixState>; 2],
) -> Ordering {
    let left_suffix = suffix_states[left.decision.next_requires_open]
        .expect("chosen plan must reference a valid suffix");
    let right_suffix = suffix_states[right.decision.next_requires_open]
        .expect("chosen plan must reference a valid suffix");
    match (
        left.decision.candidate_index,
        right.decision.candidate_index,
    ) {
        (Some(left_index), Some(right_index)) => inventory.candidates[left_index]
            .id
            .cmp(&inventory.candidates[right_index].id)
            .then_with(|| left_suffix.sequence_rank.cmp(&right_suffix.sequence_rank)),
        (Some(_), None) => {
            if right_suffix.sequence_is_empty {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        (None, Some(_)) => {
            if left_suffix.sequence_is_empty {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
        (None, None) => left_suffix.sequence_rank.cmp(&right_suffix.sequence_rank),
    }
}

fn build_refinement_batch(
    inventory: &FineCandidateInventory,
    optimistic: Option<&OptimisticOmittedAssignment>,
    batch_size: usize,
    cancel: Option<&AtomicBool>,
) -> Result<RefinementBatch, FineFrontierError> {
    let Some(optimistic) = optimistic else {
        return Ok(RefinementBatch {
            candidate_ids: Vec::new(),
            deferred_candidate_count: 0,
        });
    };

    let mut by_id = BTreeMap::new();
    for (candidate_index, candidate) in inventory.candidates.iter().enumerate() {
        check_cancel_periodically(cancel, candidate_index)?;
        by_id.insert(candidate.id, candidate);
    }
    let mut candidates = Vec::with_capacity(optimistic.unresolved_candidate_ids.len());
    for (candidate_index, id) in optimistic.unresolved_candidate_ids.iter().enumerate() {
        check_cancel_periodically(cancel, candidate_index)?;
        if let Some(candidate) = by_id.get(id).copied() {
            candidates.push(candidate);
        }
    }
    check_cancel(cancel)?;
    candidates.sort_unstable_by(|left, right| {
        right
            .coarse_upper_bound
            .cmp(&left.coarse_upper_bound)
            .then_with(|| left.id.cmp(&right.id))
    });
    let deferred_candidate_count = candidates.len().saturating_sub(batch_size);
    candidates.truncate(batch_size);
    check_cancel(cancel)?;
    Ok(RefinementBatch {
        candidate_ids: candidates
            .into_iter()
            .map(|candidate| candidate.id)
            .collect(),
        deferred_candidate_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(value: u32) -> ScoreMicros {
        ScoreMicros::new(value).expect("test score must be in range")
    }

    fn id(pair: u32, candidate: u32) -> FineCandidateId {
        FineCandidateId {
            pair_ordinal: pair,
            candidate_ordinal: candidate,
        }
    }

    fn candidate(
        pair: u32,
        candidate_ordinal: u32,
        upper: u32,
        state: FineEvaluationState,
    ) -> FineCandidate {
        FineCandidate {
            id: id(pair, candidate_ordinal),
            coarse_upper_bound: score(upper),
            physical_occupancy: None,
            state,
        }
    }

    fn scored(pair: u32, candidate_ordinal: u32, upper: u32, fine: u32) -> FineCandidate {
        let unique_source_space = pair
            .checked_mul(100_000)
            .and_then(|base| {
                candidate_ordinal
                    .checked_mul(2)
                    .and_then(|value| base.checked_add(value))
            })
            .expect("test scored helper needs a unique physical space");
        with_occupancy(
            candidate(
                pair,
                candidate_ordinal,
                upper,
                FineEvaluationState::Scored { score: score(fine) },
            ),
            unique_source_space,
            vec![PhysicalInterval {
                start_ms: 0,
                end_ms: 1,
            }],
            unique_source_space
                .checked_add(1)
                .expect("test target space must fit in u32"),
            vec![PhysicalInterval {
                start_ms: 0,
                end_ms: 1,
            }],
        )
    }

    fn with_occupancy(
        mut candidate: FineCandidate,
        source_space_ordinal: u32,
        source_intervals: Vec<PhysicalInterval>,
        target_space_ordinal: u32,
        target_intervals: Vec<PhysicalInterval>,
    ) -> FineCandidate {
        candidate.physical_occupancy = Some(PairPhysicalOccupancy {
            source: PhysicalAxisOccupancy {
                space_ordinal: source_space_ordinal,
                reuse_group_ordinal: None,
                intervals: source_intervals,
            },
            target: PhysicalAxisOccupancy {
                space_ordinal: target_space_ordinal,
                reuse_group_ordinal: None,
                intervals: target_intervals,
            },
        });
        candidate
    }

    fn with_source_interval(
        mut candidate: FineCandidate,
        space_ordinal: u32,
        start_ms: u64,
        end_ms: u64,
    ) -> FineCandidate {
        let fallback_target_space = if space_ordinal == u32::MAX {
            u32::MAX - 1
        } else {
            space_ordinal + 1
        };
        let occupancy = candidate
            .physical_occupancy
            .get_or_insert_with(|| PairPhysicalOccupancy {
                source: PhysicalAxisOccupancy {
                    space_ordinal,
                    reuse_group_ordinal: None,
                    intervals: vec![PhysicalInterval { start_ms, end_ms }],
                },
                target: PhysicalAxisOccupancy {
                    space_ordinal: fallback_target_space,
                    reuse_group_ordinal: None,
                    intervals: vec![PhysicalInterval {
                        start_ms: 0,
                        end_ms: 1,
                    }],
                },
            });
        occupancy.source = PhysicalAxisOccupancy {
            space_ordinal,
            reuse_group_ordinal: None,
            intervals: vec![PhysicalInterval { start_ms, end_ms }],
        };
        candidate
    }

    fn with_source_reuse_group(mut candidate: FineCandidate, group_ordinal: u32) -> FineCandidate {
        candidate
            .physical_occupancy
            .as_mut()
            .expect("test candidate must have occupancy")
            .source
            .reuse_group_ordinal = Some(group_ordinal);
        candidate
    }

    fn interval(start_ms: u64, end_ms: u64) -> PhysicalInterval {
        PhysicalInterval { start_ms, end_ms }
    }

    fn brute_force_conflicts(
        left: &FineCandidate,
        right: &FineCandidate,
        overlap_tolerance_ms: u64,
    ) -> bool {
        let (Some(left_occupancy), Some(right_occupancy)) =
            (&left.physical_occupancy, &right.physical_occupancy)
        else {
            return false;
        };
        [
            (&left_occupancy.source, &right_occupancy.source),
            (&left_occupancy.target, &right_occupancy.target),
        ]
        .iter()
        .any(|(left_axis, right_axis)| {
            left_axis.space_ordinal == right_axis.space_ordinal
                && !axis_reuse_is_explicitly_shared(left_axis, right_axis)
                && left_axis.intervals.iter().any(|left_interval| {
                    right_axis.intervals.iter().any(|right_interval| {
                        let overlap_start = left_interval.start_ms.max(right_interval.start_ms);
                        let overlap_end = left_interval.end_ms.min(right_interval.end_ms);
                        overlap_end.saturating_sub(overlap_start) > overlap_tolerance_ms
                    })
                })
        })
    }

    fn brute_force_exact_top_two(
        inventory: &FineCandidateInventory,
        overlap_tolerance_ms: u64,
    ) -> (ExactAssignment, Option<ExactAssignment>) {
        fn visit(
            inventory: &FineCandidateInventory,
            pairs: &[Vec<usize>],
            overlap_tolerance_ms: u64,
            pair_index: usize,
            selected: &mut Vec<usize>,
            total_score_micros: u64,
            assignments: &mut Vec<ExactAssignment>,
        ) {
            if pair_index == pairs.len() {
                assignments.push(ExactAssignment {
                    candidate_ids: selected
                        .iter()
                        .map(|index| inventory.candidates[*index].id)
                        .collect(),
                    total_score_micros,
                });
                return;
            }

            visit(
                inventory,
                pairs,
                overlap_tolerance_ms,
                pair_index + 1,
                selected,
                total_score_micros,
                assignments,
            );
            for candidate_index in &pairs[pair_index] {
                if selected.iter().any(|selected_index| {
                    brute_force_conflicts(
                        &inventory.candidates[*candidate_index],
                        &inventory.candidates[*selected_index],
                        overlap_tolerance_ms,
                    )
                }) {
                    continue;
                }
                selected.push(*candidate_index);
                visit(
                    inventory,
                    pairs,
                    overlap_tolerance_ms,
                    pair_index + 1,
                    selected,
                    total_score_micros + scored_value(&inventory.candidates[*candidate_index]),
                    assignments,
                );
                selected.pop();
            }
        }

        let mut by_pair = BTreeMap::<u32, Vec<usize>>::new();
        for (index, candidate) in inventory.candidates.iter().enumerate() {
            if matches!(candidate.state, FineEvaluationState::Scored { .. }) {
                by_pair
                    .entry(candidate.id.pair_ordinal)
                    .or_default()
                    .push(index);
            }
        }
        for indices in by_pair.values_mut() {
            indices.sort_unstable_by_key(|index| inventory.candidates[*index].id);
        }
        let pairs = by_pair.into_values().collect::<Vec<_>>();
        let mut assignments = Vec::new();
        visit(
            inventory,
            &pairs,
            overlap_tolerance_ms,
            0,
            &mut Vec::new(),
            0,
            &mut assignments,
        );
        assignments.sort_unstable_by(|left, right| {
            right
                .total_score_micros
                .cmp(&left.total_score_micros)
                .then_with(|| left.candidate_ids.cmp(&right.candidate_ids))
        });
        let best = assignments.remove(0);
        let runner_up = (!assignments.is_empty()).then(|| assignments.remove(0));
        (best, runner_up)
    }

    fn brute_force_optimistic_assignment(
        inventory: &FineCandidateInventory,
    ) -> Option<(Vec<FineCandidateId>, u64)> {
        fn visit(
            inventory: &FineCandidateInventory,
            pairs: &[Vec<usize>],
            pair_index: usize,
            selected: &mut Vec<usize>,
            total_upper_bound_micros: u64,
            has_open: bool,
            assignments: &mut Vec<(Vec<FineCandidateId>, u64)>,
        ) {
            if pair_index == pairs.len() {
                if has_open {
                    assignments.push((
                        selected
                            .iter()
                            .map(|index| inventory.candidates[*index].id)
                            .collect(),
                        total_upper_bound_micros,
                    ));
                }
                return;
            }

            visit(
                inventory,
                pairs,
                pair_index + 1,
                selected,
                total_upper_bound_micros,
                has_open,
                assignments,
            );
            for candidate_index in &pairs[pair_index] {
                let candidate = &inventory.candidates[*candidate_index];
                let contribution_micros = match candidate.state {
                    FineEvaluationState::Scored { score } => u64::from(score.get()),
                    FineEvaluationState::EvaluatedIneligible => continue,
                    _ => u64::from(candidate.coarse_upper_bound.get()),
                };
                selected.push(*candidate_index);
                visit(
                    inventory,
                    pairs,
                    pair_index + 1,
                    selected,
                    total_upper_bound_micros + contribution_micros,
                    has_open || candidate.state.is_open(),
                    assignments,
                );
                selected.pop();
            }
        }

        let mut by_pair = BTreeMap::<u32, Vec<usize>>::new();
        for (index, candidate) in inventory.candidates.iter().enumerate() {
            if !matches!(candidate.state, FineEvaluationState::EvaluatedIneligible) {
                by_pair
                    .entry(candidate.id.pair_ordinal)
                    .or_default()
                    .push(index);
            }
        }
        for indices in by_pair.values_mut() {
            indices.sort_unstable_by_key(|index| inventory.candidates[*index].id);
        }
        let pairs = by_pair.into_values().collect::<Vec<_>>();
        let mut assignments = Vec::new();
        visit(
            inventory,
            &pairs,
            0,
            &mut Vec::new(),
            0,
            false,
            &mut assignments,
        );
        assignments.sort_unstable_by(|left, right| {
            right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0))
        });
        assignments.into_iter().next()
    }

    #[test]
    fn score_micros_accepts_both_boundaries_and_rejects_one_past_the_maximum() {
        assert_eq!(ScoreMicros::new(0), Ok(ScoreMicros::ZERO));
        assert_eq!(ScoreMicros::new(SCORE_MICROS_ONE), Ok(ScoreMicros::ONE));
        assert_eq!(
            ScoreMicros::new(SCORE_MICROS_ONE + 1),
            Err(ScoreMicrosError {
                value: SCORE_MICROS_ONE + 1,
            })
        );
    }

    #[test]
    fn empty_inventory_is_explicitly_no_eligible_candidate() {
        let outcome = analyze_fine_frontier(
            &FineCandidateInventory::default(),
            FineFrontierConfig::default(),
        )
        .unwrap();

        assert_eq!(outcome.state, FineFrontierState::NoEligibleCandidate);
        assert!(!outcome.resolved);
        assert!(outcome.best_completed.candidate_ids.is_empty());
        assert!(outcome.optimistic_omitted.is_none());
    }

    #[test]
    fn fully_ineligible_inventory_is_explicitly_no_eligible_candidate() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                candidate(0, 0, 900_000, FineEvaluationState::EvaluatedIneligible),
                candidate(1, 0, 800_000, FineEvaluationState::EvaluatedIneligible),
            ],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        assert_eq!(outcome.state, FineFrontierState::NoEligibleCandidate);
        assert!(!outcome.resolved);
        assert!(outcome.best_completed.candidate_ids.is_empty());
        assert!(outcome.optimistic_omitted.is_none());
    }

    #[test]
    fn resolved_proof_does_not_publish_stale_refinement_work() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                scored(0, 0, 900_000, 800_000),
                candidate(0, 1, 100_000, FineEvaluationState::Unresolved),
            ],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();

        assert_eq!(outcome.state, FineFrontierState::Resolved);
        assert_eq!(outcome.best_completed.candidate_ids, vec![id(0, 0)]);
        assert!(outcome.proof.beats_optimistic_omitted_with_margin);
        assert!(outcome.next_refinement.candidate_ids.is_empty());
        assert_eq!(outcome.next_refinement.deferred_candidate_count, 0);
    }

    #[test]
    fn cancellation_fails_closed_without_a_partial_outcome() {
        let inventory = FineCandidateInventory {
            candidates: vec![scored(0, 0, 900_000, 800_000)],
        };
        let cancel = AtomicBool::new(true);

        assert_eq!(
            analyze_fine_frontier_with_cancel(
                &inventory,
                FineFrontierConfig::default(),
                Some(&cancel),
            ),
            Err(FineFrontierError::Cancelled)
        );
    }

    #[test]
    fn every_blocked_state_retains_its_upper_bound_as_unknown() {
        for blocked_state in [
            FineEvaluationState::EvidenceBlocked,
            FineEvaluationState::ResourceBlocked,
            FineEvaluationState::InfrastructureFailed,
            FineEvaluationState::Cancelled,
        ] {
            let inventory = FineCandidateInventory {
                candidates: vec![candidate(0, 0, 900_000, blocked_state)],
            };

            let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
            let omitted = outcome.optimistic_omitted.unwrap();
            assert_eq!(outcome.state, FineFrontierState::Unresolved);
            assert!(!outcome.resolved);
            assert_eq!(omitted.total_upper_bound_micros, 900_000);
            assert_eq!(omitted.open_candidate_ids, vec![id(0, 0)]);
            assert_eq!(omitted.blocked_candidate_ids, vec![id(0, 0)]);
            assert!(omitted.unresolved_candidate_ids.is_empty());
            assert!(outcome.next_refinement.candidate_ids.is_empty());
        }
    }

    #[test]
    fn k_plus_one_candidate_is_refined_and_can_later_win() {
        let mut candidates = (0..5)
            .map(|ordinal| scored(0, ordinal, 1_000_000, 100_000))
            .collect::<Vec<_>>();
        candidates.push(candidate(0, 5, 900_000, FineEvaluationState::Unresolved));
        let inventory = FineCandidateInventory { candidates };

        let pending = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        assert!(!pending.resolved);
        assert_eq!(pending.next_refinement.candidate_ids, vec![id(0, 5)]);
        assert_eq!(
            pending
                .optimistic_omitted
                .as_ref()
                .unwrap()
                .total_upper_bound_micros,
            900_000
        );

        let mut evaluated = inventory;
        evaluated.candidates[5] = scored(0, 5, 900_000, 850_000);
        let finished = analyze_fine_frontier(&evaluated, FineFrontierConfig::default()).unwrap();
        assert!(finished.resolved);
        assert_eq!(finished.best_completed.candidate_ids, vec![id(0, 5)]);
        assert_eq!(finished.best_completed.total_score_micros, 850_000);
    }

    #[test]
    fn global_conflict_forces_a_pair_to_use_its_lower_ranked_candidate() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                with_source_interval(scored(0, 0, 900_000, 900_000), 7, 0, 1_000),
                with_source_interval(scored(0, 1, 600_000, 600_000), 7, 1_000, 2_000),
                with_source_interval(scored(1, 0, 850_000, 850_000), 7, 0, 1_000),
                with_source_interval(scored(1, 1, 100_000, 100_000), 7, 2_000, 3_000),
            ],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        assert_eq!(
            outcome.best_completed.candidate_ids,
            vec![id(0, 1), id(1, 0)]
        );
        assert_eq!(outcome.best_completed.total_score_micros, 1_450_000);
    }

    #[test]
    fn resource_blocked_candidate_retains_its_upper_bound() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                scored(0, 0, 500_000, 500_000),
                candidate(0, 1, 900_000, FineEvaluationState::ResourceBlocked),
            ],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        let omitted = outcome.optimistic_omitted.unwrap();
        assert!(!outcome.resolved);
        assert_eq!(omitted.total_upper_bound_micros, 900_000);
        assert_eq!(omitted.blocked_candidate_ids, vec![id(0, 1)]);
        assert!(outcome.next_refinement.candidate_ids.is_empty());
    }

    #[test]
    fn fine_score_above_coarse_upper_is_rejected() {
        let inventory = FineCandidateInventory {
            candidates: vec![scored(0, 0, 700_000, 700_001)],
        };

        assert_eq!(
            analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
            Err(FineFrontierError::FineScoreExceedsCoarseUpper {
                id: id(0, 0),
                fine_score: score(700_001),
                coarse_upper_bound: score(700_000),
            })
        );
    }

    #[test]
    fn scored_candidate_without_physical_occupancy_is_rejected() {
        let inventory = FineCandidateInventory {
            candidates: vec![candidate(
                0,
                0,
                700_000,
                FineEvaluationState::Scored {
                    score: score(600_000),
                },
            )],
        };

        assert_eq!(
            analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
            Err(FineFrontierError::MissingScoredPhysicalOccupancy { id: id(0, 0) })
        );
    }

    #[test]
    fn scored_candidate_with_empty_source_axis_is_rejected() {
        let mut invalid = scored(0, 0, 700_000, 600_000);
        invalid
            .physical_occupancy
            .as_mut()
            .unwrap()
            .source
            .intervals
            .clear();
        let inventory = FineCandidateInventory {
            candidates: vec![invalid],
        };

        assert_eq!(
            analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
            Err(FineFrontierError::EmptyPhysicalAxisOccupancy {
                id: id(0, 0),
                axis: PhysicalAxisKind::Source,
                space_ordinal: 0,
            })
        );
    }

    #[test]
    fn scored_candidate_with_empty_target_axis_is_rejected() {
        let mut invalid = scored(0, 0, 700_000, 600_000);
        invalid
            .physical_occupancy
            .as_mut()
            .unwrap()
            .target
            .intervals
            .clear();
        let inventory = FineCandidateInventory {
            candidates: vec![invalid],
        };

        assert_eq!(
            analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
            Err(FineFrontierError::EmptyPhysicalAxisOccupancy {
                id: id(0, 0),
                axis: PhysicalAxisKind::Target,
                space_ordinal: 1,
            })
        );
    }

    #[test]
    fn separated_sorted_intervals_are_canonical() {
        let inventory = FineCandidateInventory {
            candidates: vec![with_occupancy(
                scored(0, 0, 700_000, 600_000),
                10,
                vec![interval(0, 100), interval(101, 200)],
                11,
                vec![interval(500, 600), interval(700, 800)],
            )],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        assert_eq!(outcome.state, FineFrontierState::Resolved);
        assert_eq!(outcome.best_completed.candidate_ids, vec![id(0, 0)]);
    }

    #[test]
    fn adjacent_intervals_must_be_merged_before_analysis() {
        let invalid = with_occupancy(
            scored(0, 0, 700_000, 600_000),
            10,
            vec![interval(0, 100), interval(100, 200)],
            11,
            vec![interval(0, 1)],
        );
        let inventory = FineCandidateInventory {
            candidates: vec![invalid],
        };

        assert!(matches!(
            analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
            Err(FineFrontierError::NonCanonicalPhysicalIntervals {
                axis: PhysicalAxisKind::Source,
                previous: PhysicalInterval {
                    start_ms: 0,
                    end_ms: 100,
                },
                current: PhysicalInterval {
                    start_ms: 100,
                    end_ms: 200,
                },
                ..
            })
        ));
    }

    #[test]
    fn overlapping_or_unsorted_intervals_are_rejected() {
        for intervals in [
            vec![interval(0, 101), interval(100, 200)],
            vec![interval(100, 200), interval(0, 50)],
        ] {
            let inventory = FineCandidateInventory {
                candidates: vec![with_occupancy(
                    scored(0, 0, 700_000, 600_000),
                    10,
                    intervals,
                    11,
                    vec![interval(0, 1)],
                )],
            };

            assert!(matches!(
                analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
                Err(FineFrontierError::NonCanonicalPhysicalIntervals {
                    axis: PhysicalAxisKind::Source,
                    ..
                })
            ));
        }
    }

    #[test]
    fn overlap_equal_to_tolerance_is_allowed_but_one_more_millisecond_conflicts() {
        let at_tolerance = FineCandidateInventory {
            candidates: vec![
                with_source_interval(scored(0, 0, 600_000, 600_000), 42, 0, 1_000),
                with_source_interval(scored(1, 0, 500_000, 500_000), 42, 750, 1_750),
            ],
        };
        let allowed = analyze_fine_frontier(&at_tolerance, FineFrontierConfig::default()).unwrap();
        assert_eq!(
            allowed.best_completed.candidate_ids,
            vec![id(0, 0), id(1, 0)]
        );
        assert_eq!(allowed.best_completed.total_score_micros, 1_100_000);
        assert!(allowed.search.interval_comparisons > 0);

        let over_tolerance = FineCandidateInventory {
            candidates: vec![
                with_source_interval(scored(0, 0, 600_000, 600_000), 42, 0, 1_000),
                with_source_interval(scored(1, 0, 500_000, 500_000), 42, 749, 1_749),
            ],
        };
        let blocked =
            analyze_fine_frontier(&over_tolerance, FineFrontierConfig::default()).unwrap();
        assert_eq!(blocked.best_completed.candidate_ids, vec![id(0, 0)]);
        assert_eq!(blocked.best_completed.total_score_micros, 600_000);
    }

    #[test]
    fn explicit_same_version_group_allows_shared_physical_interval() {
        let shared = FineCandidateInventory {
            candidates: vec![
                with_source_reuse_group(
                    with_source_interval(scored(0, 0, 600_000, 600_000), 42, 0, 1_000),
                    7,
                ),
                with_source_reuse_group(
                    with_source_interval(scored(1, 0, 500_000, 500_000), 42, 100, 1_100),
                    7,
                ),
            ],
        };
        let outcome = analyze_fine_frontier(&shared, FineFrontierConfig::default()).unwrap();
        assert_eq!(
            outcome.best_completed.candidate_ids,
            vec![id(0, 0), id(1, 0)]
        );
        assert_eq!(outcome.best_completed.total_score_micros, 1_100_000);

        let mismatched = FineCandidateInventory {
            candidates: vec![
                with_source_reuse_group(
                    with_source_interval(scored(0, 0, 600_000, 600_000), 42, 0, 1_000),
                    7,
                ),
                with_source_reuse_group(
                    with_source_interval(scored(1, 0, 500_000, 500_000), 42, 100, 1_100),
                    8,
                ),
            ],
        };
        let outcome = analyze_fine_frontier(&mismatched, FineFrontierConfig::default()).unwrap();
        assert_eq!(outcome.best_completed.candidate_ids, vec![id(0, 0)]);
    }

    #[test]
    fn zero_reuse_group_is_rejected() {
        let inventory = FineCandidateInventory {
            candidates: vec![with_source_reuse_group(
                with_source_interval(scored(0, 0, 600_000, 600_000), 42, 0, 1_000),
                0,
            )],
        };
        assert!(matches!(
            analyze_fine_frontier(&inventory, FineFrontierConfig::default()),
            Err(FineFrontierError::InvalidReuseGroupOrdinal {
                axis: PhysicalAxisKind::Source,
                ..
            })
        ));
    }

    #[test]
    fn source_and_target_roles_never_create_cross_axis_conflicts() {
        let cross_role_alias = FineCandidateInventory {
            candidates: vec![
                with_occupancy(
                    scored(0, 0, 600_000, 600_000),
                    42,
                    vec![interval(0, 1_000)],
                    7,
                    vec![interval(0, 1_000)],
                ),
                with_occupancy(
                    scored(1, 0, 500_000, 500_000),
                    8,
                    vec![interval(0, 1_000)],
                    42,
                    vec![interval(0, 1_000)],
                ),
            ],
        };
        let outcome =
            analyze_fine_frontier(&cross_role_alias, FineFrontierConfig::default()).unwrap();
        assert_eq!(
            outcome.best_completed.candidate_ids,
            vec![id(0, 0), id(1, 0)]
        );

        let same_numeric_ordinal = FineCandidateInventory {
            candidates: vec![with_occupancy(
                scored(0, 0, 600_000, 600_000),
                9,
                vec![interval(0, 1_000)],
                9,
                vec![interval(0, 1_000)],
            )],
        };
        assert_eq!(
            analyze_fine_frontier(&same_numeric_ordinal, FineFrontierConfig::default())
                .unwrap()
                .state,
            FineFrontierState::Resolved
        );
    }

    #[test]
    fn per_axis_and_total_interval_limits_fail_closed() {
        let inventory = FineCandidateInventory {
            candidates: vec![with_occupancy(
                scored(0, 0, 700_000, 600_000),
                10,
                vec![interval(0, 100), interval(200, 300)],
                11,
                vec![interval(0, 100), interval(200, 300)],
            )],
        };

        let mut per_axis_config = FineFrontierConfig::default();
        per_axis_config.limits.max_intervals_per_axis = 1;
        assert_eq!(
            analyze_fine_frontier(&inventory, per_axis_config),
            Err(FineFrontierError::IntervalLimitExceeded {
                kind: IntervalLimitKind::PerAxis,
                id: Some(id(0, 0)),
                axis: Some(PhysicalAxisKind::Source),
                interval_count: 2,
                limit: 1,
            })
        );

        let mut total_config = FineFrontierConfig::default();
        total_config.limits.max_total_intervals = 3;
        assert_eq!(
            analyze_fine_frontier(&inventory, total_config),
            Err(FineFrontierError::IntervalLimitExceeded {
                kind: IntervalLimitKind::TotalInventory,
                id: None,
                axis: None,
                interval_count: 4,
                limit: 3,
            })
        );
    }

    #[test]
    fn interval_comparison_budget_fails_closed() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                with_occupancy(
                    scored(0, 0, 600_000, 600_000),
                    42,
                    vec![interval(0, 100), interval(1_000, 1_200)],
                    43,
                    vec![interval(0, 1)],
                ),
                with_occupancy(
                    scored(1, 0, 500_000, 500_000),
                    42,
                    vec![interval(200, 300), interval(1_000, 1_200)],
                    44,
                    vec![interval(0, 1)],
                ),
            ],
        };
        let mut config = FineFrontierConfig::default();
        config.limits.max_interval_comparisons = 1;

        assert!(matches!(
            analyze_fine_frontier(&inventory, config),
            Err(FineFrontierError::SearchLimitExceeded {
                kind: SearchLimitKind::IntervalComparisons,
                limit: 1,
                search,
            }) if search.interval_comparisons == 1
        ));
    }

    #[test]
    fn inventory_order_does_not_change_frontier_or_search() {
        let candidates = vec![
            candidate(2, 3, 810_000, FineEvaluationState::Unresolved),
            with_source_interval(scored(0, 4, 600_000, 590_000), 1, 0, 10),
            candidate(1, 8, 750_000, FineEvaluationState::EvidenceBlocked),
            with_source_interval(scored(2, 1, 500_000, 480_000), 1, 10, 20),
            scored(0, 2, 580_000, 570_000),
        ];
        let forward = FineCandidateInventory {
            candidates: candidates.clone(),
        };
        let reverse = FineCandidateInventory {
            candidates: candidates.into_iter().rev().collect(),
        };

        let forward_outcome =
            analyze_fine_frontier(&forward, FineFrontierConfig::default()).unwrap();
        let reverse_outcome =
            analyze_fine_frontier(&reverse, FineFrontierConfig::default()).unwrap();
        assert_eq!(forward_outcome, reverse_outcome);
    }

    #[test]
    fn optimistic_zero_score_tie_keeps_the_canonical_earlier_id() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                scored(0, 0, 0, 0),
                candidate(1, 0, 0, FineEvaluationState::Unresolved),
            ],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        assert_eq!(
            outcome.optimistic_omitted.unwrap().candidate_ids,
            vec![id(0, 0), id(1, 0)]
        );
    }

    #[test]
    fn candidate_budget_fails_closed_instead_of_truncating() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                scored(0, 0, 500_000, 400_000),
                scored(0, 1, 500_000, 300_000),
            ],
        };
        let mut config = FineFrontierConfig::default();
        config.limits.max_candidates = 1;

        assert_eq!(
            analyze_fine_frontier(&inventory, config),
            Err(FineFrontierError::CandidateLimitExceeded {
                candidate_count: 2,
                max_candidates: 1,
            })
        );
    }

    #[test]
    fn search_state_limit_fails_closed_without_partial_assignment() {
        let inventory = FineCandidateInventory {
            candidates: vec![scored(0, 0, 500_000, 400_000)],
        };
        let mut config = FineFrontierConfig::default();
        config.limits.max_search_states = 1;

        assert!(matches!(
            analyze_fine_frontier(&inventory, config),
            Err(FineFrontierError::SearchLimitExceeded {
                kind: SearchLimitKind::States,
                limit: 1,
                search,
            }) if search.states_visited == 1
        ));
    }

    #[test]
    fn search_expansion_limit_fails_closed_without_partial_assignment() {
        let inventory = FineCandidateInventory {
            candidates: vec![scored(0, 0, 500_000, 400_000)],
        };
        let mut config = FineFrontierConfig::default();
        config.limits.max_search_expansions = 1;

        assert!(matches!(
            analyze_fine_frontier(&inventory, config),
            Err(FineFrontierError::SearchLimitExceeded {
                kind: SearchLimitKind::Expansions,
                limit: 1,
                search,
            }) if search.expansions_considered == 1
        ));
    }

    #[test]
    fn optimistic_assignment_ignores_physical_conflicts_to_remain_an_upper_bound() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                with_source_interval(
                    candidate(0, 0, 800_000, FineEvaluationState::Unresolved),
                    3,
                    0,
                    1_000,
                ),
                with_source_interval(
                    candidate(1, 0, 700_000, FineEvaluationState::Unresolved),
                    3,
                    0,
                    1_000,
                ),
            ],
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        let omitted = outcome.optimistic_omitted.unwrap();
        assert_eq!(omitted.candidate_ids, vec![id(0, 0), id(1, 0)]);
        assert_eq!(omitted.total_upper_bound_micros, 1_500_000);
        assert_eq!(
            outcome.next_refinement.candidate_ids,
            vec![id(0, 0), id(1, 0)]
        );
    }

    #[test]
    fn optimistic_frontier_handles_many_pairs_without_quadratic_prefixes() {
        const PAIR_COUNT: u32 = 32_768;
        let inventory = FineCandidateInventory {
            candidates: (0..PAIR_COUNT)
                .map(|pair| candidate(pair, 0, 1, FineEvaluationState::Unresolved))
                .collect(),
        };

        let outcome = analyze_fine_frontier(&inventory, FineFrontierConfig::default()).unwrap();
        let optimistic = outcome.optimistic_omitted.unwrap();
        assert_eq!(optimistic.candidate_ids.len(), PAIR_COUNT as usize);
        assert_eq!(optimistic.total_upper_bound_micros, u64::from(PAIR_COUNT));
        assert_eq!(optimistic.candidate_ids.first(), Some(&id(0, 0)));
        assert_eq!(
            optimistic.candidate_ids.last(),
            Some(&id(PAIR_COUNT - 1, 0))
        );
        assert_eq!(
            outcome.next_refinement.deferred_candidate_count,
            PAIR_COUNT as usize - FineFrontierLimits::default().refinement_batch_size
        );
        assert_eq!(outcome.search.states_visited, 1);
    }

    #[test]
    fn exact_and_optimistic_results_match_small_exhaustive_oracles() {
        for pair_count in 2_u32..=4 {
            let mut candidates = Vec::new();
            for pair in 0..pair_count {
                let fine = if pair % 2 == 0 { 500_000 } else { 400_000 };
                let primary = if pair <= 1 {
                    let start_ms = if pair == 0 { 0 } else { 749 };
                    with_source_interval(
                        scored(pair, 0, 900_000, fine),
                        77,
                        start_ms,
                        start_ms + 1_000,
                    )
                } else {
                    scored(pair, 0, 900_000, fine)
                };
                candidates.push(primary);
                candidates.push(match pair % 3 {
                    0 => candidate(pair, 1, fine, FineEvaluationState::Unresolved),
                    1 => candidate(
                        pair,
                        1,
                        fine + 100_000,
                        FineEvaluationState::EvidenceBlocked,
                    ),
                    _ => scored(pair, 1, fine, fine),
                });
                candidates.push(candidate(
                    pair,
                    2,
                    1_000_000,
                    FineEvaluationState::EvaluatedIneligible,
                ));
            }
            candidates.reverse();
            let inventory = FineCandidateInventory { candidates };
            let config = FineFrontierConfig::default();
            let outcome = analyze_fine_frontier(&inventory, config).unwrap();
            let (expected_best, expected_runner_up) =
                brute_force_exact_top_two(&inventory, config.overlap_tolerance_ms);
            assert_eq!(outcome.best_completed, expected_best);
            assert_eq!(outcome.runner_up_completed, expected_runner_up);

            let expected_optimistic = brute_force_optimistic_assignment(&inventory).unwrap();
            let actual_optimistic = outcome.optimistic_omitted.unwrap();
            assert_eq!(actual_optimistic.candidate_ids, expected_optimistic.0);
            assert_eq!(
                actual_optimistic.total_upper_bound_micros,
                expected_optimistic.1
            );
        }
    }

    #[test]
    fn resolution_requires_strict_margin_against_runner_up() {
        let inventory = FineCandidateInventory {
            candidates: vec![
                scored(0, 0, 500_000, 500_000),
                scored(0, 1, 490_000, 490_000),
            ],
        };
        let config = FineFrontierConfig {
            resolution_margin_micros: 10_000,
            ..FineFrontierConfig::default()
        };

        let outcome = analyze_fine_frontier(&inventory, config).unwrap();
        assert!(!outcome.resolved);
        assert!(!outcome.proof.beats_runner_up_with_margin);
    }
}
