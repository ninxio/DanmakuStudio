//! Opt-in real-media regression through the production batch planner and fine frontier.
use super::*;

#[test]
#[ignore = "Requires DTS_PARTIAL_BATCH_REQUEST and DTS_PARTIAL_BATCH_OUTPUT; reads local media"]
fn real_partial_overlap_batch_preserves_expected_pairs() {
    let input =
        std::fs::read_to_string(std::env::var("DTS_PARTIAL_BATCH_REQUEST").unwrap()).unwrap();
    let envelope: serde_json::Value = serde_json::from_str(&input).unwrap();
    let request: AudioAlignmentBatchRequest =
        serde_json::from_value(envelope["request"].clone()).unwrap();
    let plan = plan_audio_alignment_batch(request).unwrap();
    let created = batch_jobs::create_job(&plan, None, None).unwrap();
    let id = created.job_id.clone();
    run_audio_alignment_batch_job(id.clone(), created.cancel_flag, plan);
    let terminal = get_audio_alignment_batch_job(id.clone()).unwrap();
    std::fs::write(
        std::env::var("DTS_PARTIAL_BATCH_OUTPUT").unwrap(),
        serde_json::to_vec_pretty(&terminal).unwrap(),
    )
    .unwrap();
    assert_eq!(
        terminal.status,
        AudioAlignmentJobStatus::Completed,
        "{:?}",
        terminal.error
    );
    let serialized = serde_json::to_value(&terminal).unwrap();
    for expected in envelope["expected"].as_array().unwrap() {
        let pair = serialized["pairs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| {
                pair["sourceMediaId"] == expected["sourceMediaId"]
                    && pair["targetMediaId"] == expected["targetMediaId"]
            })
            .unwrap();
        if let Some(expected_matched) = expected["matched"].as_bool() {
            let matched = pair["proposal"]["timeMap"]["spans"]
                .as_array()
                .is_some_and(|spans| spans.iter().any(|span| span["kind"] == "matched"));
            assert_eq!(matched, expected_matched, "pair {}", pair["pairOrdinal"]);
        }
        // A retained review proposal is not an automatic acceptance. Negative controls
        // must fail the final verifier even when the editor keeps a tentative map.
        if let Some(verified) = expected["verified"].as_bool() {
            assert_eq!(
                pair["proposal"]["timeMap"]["quality"]["level"] == "verified",
                verified
            );
            if !verified {
                assert_eq!(pair["fineFrontier"]["finalState"], "noEligibleCandidate");
            }
        }
        if let Some(range) = expected["targetStartRangeMs"].as_array() {
            let start = pair["proposal"]["matchRange"]["targetStartMs"]
                .as_i64()
                .unwrap();
            assert!(start >= range[0].as_i64().unwrap() && start <= range[1].as_i64().unwrap());
        }
    }
    batch_jobs::remove_job(&id).unwrap();
}
