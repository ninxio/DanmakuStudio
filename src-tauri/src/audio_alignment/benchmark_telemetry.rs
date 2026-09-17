use super::{AudioAlignmentJobStatus, ALIGNMENT_BENCHMARK_SCHEMA_VERSION};
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheCounts {
    pub(super) audio_feature_entries: usize,
    pub(super) landmark_entries: usize,
    pub(super) visual_feature_entries: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheCounters {
    pub(super) hits: u64,
    pub(super) misses: u64,
    pub(super) writes: u64,
    pub(super) evictions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheTelemetry {
    pub(super) generation: u64,
    pub(super) before: AlignmentBenchmarkCacheCounts,
    pub(super) after: AlignmentBenchmarkCacheCounts,
    pub(super) audio_features: AlignmentBenchmarkCacheCounters,
    pub(super) landmarks: AlignmentBenchmarkCacheCounters,
    pub(super) visual_features: AlignmentBenchmarkCacheCounters,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkStageTiming {
    pub(super) stage_key: String,
    pub(super) occurrence: u32,
    pub(super) start_tick_ns: String,
    pub(super) end_tick_ns: String,
    pub(super) elapsed_ms: f64,
    pub(super) status: AudioAlignmentJobStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkMemoryTelemetry {
    pub(super) scope: &'static str,
    pub(super) sampler: &'static str,
    pub(super) sample_interval_ms: u64,
    pub(super) sample_count: u64,
    pub(super) failed_sample_count: u64,
    pub(super) maximum_sample_gap_ms: f64,
    pub(super) peak_process_tree_rss_bytes: Option<u64>,
    pub(super) coverage_complete: bool,
    pub(super) process_tree_empty_at_terminal: bool,
    pub(super) residual_process_count: usize,
}

impl AlignmentBenchmarkMemoryTelemetry {
    fn new(sample_interval_ms: u64) -> Self {
        Self {
            scope: "application-process-tree",
            sampler: if cfg!(windows) {
                "windows-job-object-working-set-v1"
            } else {
                "unsupported"
            },
            sample_interval_ms,
            sample_count: 0,
            failed_sample_count: 0,
            maximum_sample_gap_ms: 0.0,
            peak_process_tree_rss_bytes: None,
            coverage_complete: cfg!(windows),
            process_tree_empty_at_terminal: false,
            residual_process_count: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCancellationTelemetry {
    pub(super) request_tick_ns: String,
    pub(super) terminal_tick_ns: String,
    pub(super) latency_ms: f64,
    pub(super) command_accepted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkJobTelemetry {
    pub(super) schema_version: u8,
    pub(super) clock: &'static str,
    pub(super) start_tick_ns: String,
    pub(super) end_tick_ns: Option<String>,
    pub(super) elapsed_ms: f64,
    pub(super) stages: Vec<AlignmentBenchmarkStageTiming>,
    pub(super) cache: AlignmentBenchmarkCacheTelemetry,
    pub(super) memory: AlignmentBenchmarkMemoryTelemetry,
    pub(super) cancellation: Option<AlignmentBenchmarkCancellationTelemetry>,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum BenchmarkCacheKind {
    AudioFeatures,
    V2Landmarks,
    VisualFeatures,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum BenchmarkCacheEvent {
    Hit,
    Miss,
    Write,
    Eviction,
}

pub(super) struct AlignmentBenchmarkRunTelemetry {
    session_origin: Instant,
    state: Mutex<AlignmentBenchmarkRunTelemetryState>,
}

struct AlignmentBenchmarkRunTelemetryState {
    stages: Vec<AlignmentBenchmarkStageTiming>,
    current_stage: Option<AlignmentBenchmarkActiveStage>,
    cache: AlignmentBenchmarkCacheTelemetry,
    memory: AlignmentBenchmarkMemoryTelemetry,
    started_tick_ns: u128,
    cancel_requested_tick_ns: Option<u128>,
    terminal_tick_ns: Option<u128>,
    last_memory_sample_at: Option<Instant>,
    memory_last_error: Option<String>,
}

struct AlignmentBenchmarkActiveStage {
    key: String,
    label: String,
    occurrence: u32,
    started_tick_ns: u128,
}

#[derive(Debug, Clone)]
pub(super) struct ProcessTreeMemorySample {
    pub(super) working_set_bytes: u64,
    pub(super) descendants: HashSet<u32>,
}

thread_local! {
    static ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY: RefCell<Option<Arc<AlignmentBenchmarkRunTelemetry>>> = const { RefCell::new(None) };
}

impl AlignmentBenchmarkRunTelemetry {
    pub(super) fn new(
        session_origin: Instant,
        sample_interval_ms: u64,
        generation: u64,
        before: AlignmentBenchmarkCacheCounts,
    ) -> Self {
        Self {
            session_origin,
            state: Mutex::new(AlignmentBenchmarkRunTelemetryState {
                stages: Vec::new(),
                current_stage: None,
                cache: AlignmentBenchmarkCacheTelemetry {
                    generation,
                    before: before.clone(),
                    after: before,
                    audio_features: AlignmentBenchmarkCacheCounters::default(),
                    landmarks: AlignmentBenchmarkCacheCounters::default(),
                    visual_features: AlignmentBenchmarkCacheCounters::default(),
                },
                memory: AlignmentBenchmarkMemoryTelemetry::new(sample_interval_ms),
                started_tick_ns: 0,
                cancel_requested_tick_ns: None,
                terminal_tick_ns: None,
                last_memory_sample_at: None,
                memory_last_error: None,
            }),
        }
    }

    pub(super) fn verify_reset_generation(
        &self,
        receipt_generation: Option<u64>,
        current_generation: u64,
    ) -> Result<(), String> {
        if receipt_generation != Some(current_generation) {
            return Err("cold cache reset receipt 未被严格绑定到当前任务。".to_string());
        }
        let state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        if state.cache.generation != current_generation
            || state.cache.before != AlignmentBenchmarkCacheCounts::default()
        {
            return Err("cold cache receipt 已签发，但任务开始时三类缓存并非全空。".to_string());
        }
        Ok(())
    }

    pub(super) fn mark_started(&self) -> Result<u128, String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        if state.started_tick_ns == 0 {
            state.started_tick_ns = tick.max(1);
        }
        Ok(state.started_tick_ns)
    }

    pub(super) fn transition_stage(&self, key: &str, label: &str) -> Result<(), String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        if state
            .current_stage
            .as_ref()
            .is_some_and(|stage| stage.key == key)
        {
            return Ok(());
        }
        close_stage(&mut state, tick, AudioAlignmentJobStatus::Completed);
        let occurrence = state
            .stages
            .iter()
            .filter(|stage| stage.stage_key == key)
            .count()
            .saturating_add(1) as u32;
        state.current_stage = Some(AlignmentBenchmarkActiveStage {
            key: key.to_string(),
            label: label.to_string(),
            occurrence,
            started_tick_ns: tick,
        });
        Ok(())
    }

    pub(super) fn record_cache_event(
        &self,
        kind: BenchmarkCacheKind,
        event: BenchmarkCacheEvent,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        let counters = match kind {
            BenchmarkCacheKind::AudioFeatures => &mut state.cache.audio_features,
            BenchmarkCacheKind::V2Landmarks => &mut state.cache.landmarks,
            BenchmarkCacheKind::VisualFeatures => &mut state.cache.visual_features,
        };
        match event {
            BenchmarkCacheEvent::Hit => counters.hits = counters.hits.saturating_add(1),
            BenchmarkCacheEvent::Miss => counters.misses = counters.misses.saturating_add(1),
            BenchmarkCacheEvent::Write => counters.writes = counters.writes.saturating_add(1),
            BenchmarkCacheEvent::Eviction => {
                counters.evictions = counters.evictions.saturating_add(1)
            }
        }
        Ok(())
    }

    pub(super) fn record_cancel_request(&self) -> Result<u128, String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        Ok(*state.cancel_requested_tick_ns.get_or_insert(tick))
    }

    pub(super) fn record_memory_sample(
        &self,
        sampled_at: Instant,
        result: Result<ProcessTreeMemorySample, String>,
        baseline_descendants: &HashSet<u32>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(previous) = state.last_memory_sample_at {
            let gap_ms = sampled_at.duration_since(previous).as_secs_f64() * 1_000.0;
            state.memory.maximum_sample_gap_ms = state.memory.maximum_sample_gap_ms.max(gap_ms);
            if gap_ms > state.memory.sample_interval_ms as f64 * 4.0 {
                state.memory.coverage_complete = false;
                state.memory_last_error =
                    Some("内存采样间隔出现超过配置值四倍的缺口。".to_string());
            }
        }
        state.last_memory_sample_at = Some(sampled_at);
        match result {
            Ok(sample) => {
                state.memory.sample_count = state.memory.sample_count.saturating_add(1);
                state.memory.peak_process_tree_rss_bytes = Some(
                    state
                        .memory
                        .peak_process_tree_rss_bytes
                        .unwrap_or(0)
                        .max(sample.working_set_bytes),
                );
                state.memory.residual_process_count =
                    sample.descendants.difference(baseline_descendants).count();
            }
            Err(error) => {
                state.memory.failed_sample_count =
                    state.memory.failed_sample_count.saturating_add(1);
                state.memory.coverage_complete = false;
                state.memory_last_error = Some(error);
            }
        }
    }

    pub(super) fn set_cache_after(
        &self,
        after: AlignmentBenchmarkCacheCounts,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        state.cache.after = after;
        Ok(())
    }

    pub(super) fn set_residual_process_count(&self, residual_count: usize) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        state.memory.residual_process_count = residual_count;
        state.memory.process_tree_empty_at_terminal = residual_count == 0;
        Ok(())
    }

    pub(super) fn finish(&self, status: AudioAlignmentJobStatus) -> Result<u128, String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        close_stage(&mut state, tick, status);
        state.terminal_tick_ns = Some(tick);
        state.memory.process_tree_empty_at_terminal = state.memory.residual_process_count == 0;
        Ok(tick)
    }

    pub(super) fn current_stage(&self) -> Result<(String, String), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        Ok(state
            .current_stage
            .as_ref()
            .map(|stage| (stage.key.clone(), stage.label.clone()))
            .unwrap_or_else(|| ("queued".to_string(), "排队".to_string())))
    }

    pub(super) fn snapshot(&self) -> Result<AlignmentBenchmarkJobTelemetry, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        let now = self.session_origin.elapsed().as_nanos();
        let end = state.terminal_tick_ns;
        let elapsed_end = end.unwrap_or(now);
        let elapsed_ms = elapsed_end.saturating_sub(state.started_tick_ns) as f64 / 1_000_000.0;
        let cancellation = state.cancel_requested_tick_ns.map(|request_tick| {
            let terminal_tick = end.unwrap_or(0);
            AlignmentBenchmarkCancellationTelemetry {
                request_tick_ns: request_tick.to_string(),
                terminal_tick_ns: end.map(|tick| tick.to_string()).unwrap_or_default(),
                latency_ms: if terminal_tick == 0 {
                    0.0
                } else {
                    terminal_tick.saturating_sub(request_tick) as f64 / 1_000_000.0
                },
                command_accepted: true,
            }
        });
        Ok(AlignmentBenchmarkJobTelemetry {
            schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
            clock: "rust-std-instant-session-relative-v1",
            start_tick_ns: state.started_tick_ns.to_string(),
            end_tick_ns: end.map(|tick| tick.to_string()),
            elapsed_ms,
            stages: state.stages.clone(),
            cache: state.cache.clone(),
            memory: state.memory.clone(),
            cancellation,
        })
    }
}

fn close_stage(
    state: &mut AlignmentBenchmarkRunTelemetryState,
    end_tick_ns: u128,
    status: AudioAlignmentJobStatus,
) {
    let Some(stage) = state.current_stage.take() else {
        return;
    };
    state.stages.push(AlignmentBenchmarkStageTiming {
        stage_key: stage.key,
        occurrence: stage.occurrence,
        start_tick_ns: stage.started_tick_ns.to_string(),
        end_tick_ns: end_tick_ns.to_string(),
        elapsed_ms: end_tick_ns.saturating_sub(stage.started_tick_ns) as f64 / 1_000_000.0,
        status,
    });
}

pub(super) fn stage(key: &str, label: &str) {
    ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| {
        if let Some(telemetry) = slot.borrow().as_ref() {
            let _ = telemetry.transition_stage(key, label);
        }
    });
}

pub(super) fn cache_event(kind: BenchmarkCacheKind, event: BenchmarkCacheEvent) {
    ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| {
        if let Some(telemetry) = slot.borrow().as_ref() {
            let _ = telemetry.record_cache_event(kind, event);
        }
    });
}

pub(super) fn with_active<T>(
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    action: impl FnOnce() -> T,
) -> T {
    let previous = ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| slot.replace(Some(telemetry)));
    let _guard = ActiveAlignmentBenchmarkTelemetryGuard { previous };
    action()
}

struct ActiveAlignmentBenchmarkTelemetryGuard {
    previous: Option<Arc<AlignmentBenchmarkRunTelemetry>>,
}

impl Drop for ActiveAlignmentBenchmarkTelemetryGuard {
    fn drop(&mut self) {
        ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| {
            slot.replace(self.previous.take());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cache_event, stage, with_active, AlignmentBenchmarkCacheCounts,
        AlignmentBenchmarkRunTelemetry, BenchmarkCacheEvent, BenchmarkCacheKind,
    };
    use crate::audio_alignment::{AudioAlignmentJobStatus, DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS};
    use std::{
        panic::{catch_unwind, AssertUnwindSafe},
        sync::Arc,
        time::Instant,
    };

    fn telemetry() -> Arc<AlignmentBenchmarkRunTelemetry> {
        Arc::new(AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        ))
    }

    #[test]
    fn nested_active_context_restores_outer_after_normal_return() {
        let outer = telemetry();
        let inner = telemetry();
        outer.mark_started().unwrap();
        inner.mark_started().unwrap();

        with_active(outer.clone(), || {
            stage("outer-before", "外层前");
            with_active(inner.clone(), || {
                stage("inner", "内层");
                cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Hit);
                inner.finish(AudioAlignmentJobStatus::Completed).unwrap();
            });
            stage("outer-after", "外层后");
            outer.finish(AudioAlignmentJobStatus::Completed).unwrap();
        });

        let outer_snapshot = outer.snapshot().unwrap();
        let inner_snapshot = inner.snapshot().unwrap();
        assert_eq!(
            outer_snapshot
                .stages
                .iter()
                .map(|stage| stage.stage_key.as_str())
                .collect::<Vec<_>>(),
            vec!["outer-before", "outer-after"]
        );
        assert_eq!(
            inner_snapshot
                .stages
                .iter()
                .map(|stage| stage.stage_key.as_str())
                .collect::<Vec<_>>(),
            vec!["inner"]
        );
        assert_eq!(outer_snapshot.cache.landmarks.hits, 0);
        assert_eq!(inner_snapshot.cache.landmarks.hits, 1);
    }

    #[test]
    fn nested_active_context_restores_outer_after_unwind() {
        let outer = telemetry();
        let inner = telemetry();
        outer.mark_started().unwrap();
        inner.mark_started().unwrap();

        with_active(outer.clone(), || {
            stage("outer-before", "外层前");
            let unwind = catch_unwind(AssertUnwindSafe(|| {
                with_active(inner.clone(), || {
                    stage("inner", "内层");
                    panic!("expected telemetry context unwind");
                });
            }));
            assert!(unwind.is_err());
            stage("outer-after", "外层后");
            outer.finish(AudioAlignmentJobStatus::Completed).unwrap();
        });
        inner.finish(AudioAlignmentJobStatus::Failed).unwrap();

        let outer_snapshot = outer.snapshot().unwrap();
        let inner_snapshot = inner.snapshot().unwrap();
        assert_eq!(
            outer_snapshot
                .stages
                .iter()
                .map(|stage| stage.stage_key.as_str())
                .collect::<Vec<_>>(),
            vec!["outer-before", "outer-after"]
        );
        assert_eq!(inner_snapshot.stages.len(), 1);
        assert_eq!(
            inner_snapshot.stages[0].status,
            AudioAlignmentJobStatus::Failed
        );
    }

    #[test]
    fn stage_and_cache_events_are_noop_without_active_context() {
        let inactive = telemetry();

        stage("unscoped", "无上下文");
        cache_event(BenchmarkCacheKind::AudioFeatures, BenchmarkCacheEvent::Hit);
        cache_event(
            BenchmarkCacheKind::VisualFeatures,
            BenchmarkCacheEvent::Write,
        );

        let snapshot = inactive.snapshot().unwrap();
        assert!(snapshot.stages.is_empty());
        assert_eq!(snapshot.cache.audio_features.hits, 0);
        assert_eq!(snapshot.cache.visual_features.writes, 0);
    }
}
