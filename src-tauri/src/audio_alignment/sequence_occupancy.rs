//! Batch-level physical reuse rules for explicit ordered relations.
//!
//! In an explicit many-to-one batch, distinct reference media are assertions
//! that every listed relation should be evaluated. Their mapped ranges may
//! legitimately overlap on the same original timeline, so the target axis gets
//! a deterministic reuse cohort. Full-cartesian discovery remains exclusive.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExplicitRelationAxis {
    pub(crate) source_media_index: usize,
    pub(crate) target_media_index: usize,
}

pub(crate) fn explicit_many_to_one_target_reuse_groups(
    relations: &[ExplicitRelationAxis],
    first_group_ordinal: u32,
) -> Result<Vec<Option<u32>>, String> {
    if first_group_ordinal == 0 {
        return Err("显式 many-to-one 复用组 ordinal 必须为非零值。".to_string());
    }

    let mut sources_by_target = BTreeMap::<usize, BTreeSet<usize>>::new();
    for relation in relations {
        sources_by_target
            .entry(relation.target_media_index)
            .or_default()
            .insert(relation.source_media_index);
    }

    let mut group_by_target = BTreeMap::<usize, u32>::new();
    let mut next_group_ordinal = first_group_ordinal;
    for (target_media_index, source_media_indices) in sources_by_target {
        if source_media_indices.len() < 2 {
            continue;
        }
        group_by_target.insert(target_media_index, next_group_ordinal);
        next_group_ordinal = next_group_ordinal
            .checked_add(1)
            .ok_or_else(|| "显式 many-to-one 复用组 ordinal 溢出；请缩小批次。".to_string())?;
    }

    Ok(relations
        .iter()
        .map(|relation| group_by_target.get(&relation.target_media_index).copied())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_sources_sharing_one_target_receive_one_group() {
        let groups = explicit_many_to_one_target_reuse_groups(
            &[
                ExplicitRelationAxis {
                    source_media_index: 1,
                    target_media_index: 9,
                },
                ExplicitRelationAxis {
                    source_media_index: 2,
                    target_media_index: 9,
                },
                ExplicitRelationAxis {
                    source_media_index: 3,
                    target_media_index: 10,
                },
            ],
            7,
        )
        .unwrap();

        assert_eq!(groups, vec![Some(7), Some(7), None]);
    }

    #[test]
    fn repeated_same_source_does_not_create_a_reuse_cohort() {
        let groups = explicit_many_to_one_target_reuse_groups(
            &[
                ExplicitRelationAxis {
                    source_media_index: 1,
                    target_media_index: 9,
                },
                ExplicitRelationAxis {
                    source_media_index: 1,
                    target_media_index: 9,
                },
            ],
            3,
        )
        .unwrap();
        assert_eq!(groups, vec![None, None]);
    }
}
