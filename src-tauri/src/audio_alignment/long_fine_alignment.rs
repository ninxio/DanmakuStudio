//! Bounded fine-extraction planning for long media.
//!
//! The 1 GiB process safety gate remains authoritative. Long windows are
//! extracted as overlapping tiles and only their irreversible fine features
//! survive between tiles; reversible PCM never accumulates for the full movie.

use crate::alignment_v2::PresentationRangeMs;

pub(crate) const DEFAULT_FINE_TILE_DURATION_MS: i64 = 10 * 60 * 1_000;
pub(crate) const DEFAULT_FINE_TILE_OVERLAP_MS: i64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BoundedFineAxisPlan {
    pub(crate) full_window: PresentationRangeMs,
    pub(crate) tiles: Vec<PresentationRangeMs>,
}

pub(crate) fn plan_bounded_fine_axis(
    full_window: PresentationRangeMs,
) -> Result<BoundedFineAxisPlan, String> {
    plan_bounded_fine_axis_with_limits(
        full_window,
        DEFAULT_FINE_TILE_DURATION_MS,
        DEFAULT_FINE_TILE_OVERLAP_MS,
    )
}

fn plan_bounded_fine_axis_with_limits(
    full_window: PresentationRangeMs,
    maximum_tile_duration_ms: i64,
    overlap_ms: i64,
) -> Result<BoundedFineAxisPlan, String> {
    if full_window.end_ms <= full_window.start_ms {
        return Err("blocked:resource-limit：long fine 完整窗口不能为空。".to_string());
    }
    if maximum_tile_duration_ms <= 0
        || overlap_ms < 0
        || overlap_ms.saturating_mul(2) >= maximum_tile_duration_ms
    {
        return Err("blocked:resource-limit：long fine tile 时长或重叠配置无效。".to_string());
    }

    let full_duration_ms = full_window
        .end_ms
        .checked_sub(full_window.start_ms)
        .ok_or_else(|| "blocked:resource-limit：long fine 完整窗口时长溢出。".to_string())?;
    if full_duration_ms <= maximum_tile_duration_ms {
        return Ok(BoundedFineAxisPlan {
            full_window,
            tiles: vec![full_window],
        });
    }

    let advance_ms = maximum_tile_duration_ms
        .checked_sub(overlap_ms)
        .ok_or_else(|| "blocked:resource-limit：long fine tile 步长溢出。".to_string())?;
    let mut tiles = Vec::new();
    let mut start_ms = full_window.start_ms;
    while start_ms < full_window.end_ms {
        let end_ms = start_ms
            .checked_add(maximum_tile_duration_ms)
            .unwrap_or(i64::MAX)
            .min(full_window.end_ms);
        tiles.push(PresentationRangeMs { start_ms, end_ms });
        if end_ms == full_window.end_ms {
            break;
        }
        let next_start_ms = start_ms
            .checked_add(advance_ms)
            .ok_or_else(|| "blocked:resource-limit：long fine tile 位置溢出。".to_string())?;
        if next_start_ms <= start_ms {
            return Err("blocked:resource-limit：long fine tile 没有向前推进。".to_string());
        }
        start_ms = next_start_ms;
    }

    Ok(BoundedFineAxisPlan { full_window, tiles })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_axis_is_covered_by_small_overlapping_tiles() {
        let plan = plan_bounded_fine_axis_with_limits(
            PresentationRangeMs {
                start_ms: 10_000,
                end_ms: 40_000,
            },
            10_000,
            500,
        )
        .unwrap();

        assert_eq!(plan.full_window.start_ms, 10_000);
        assert_eq!(plan.full_window.end_ms, 40_000);
        assert_eq!(plan.tiles.first().unwrap().start_ms, 10_000);
        assert_eq!(plan.tiles.last().unwrap().end_ms, 40_000);
        assert!(plan
            .tiles
            .iter()
            .all(|tile| tile.end_ms - tile.start_ms <= 10_000));
        assert!(plan.tiles.windows(2).all(|pair| {
            pair[0].end_ms - pair[1].start_ms == 500 && pair[1].start_ms > pair[0].start_ms
        }));
    }

    #[test]
    fn short_axis_remains_one_tile() {
        let full_window = PresentationRangeMs {
            start_ms: 25,
            end_ms: 5_025,
        };
        let plan = plan_bounded_fine_axis_with_limits(full_window, 10_000, 500).unwrap();
        assert_eq!(plan.tiles, vec![full_window]);
    }
}
