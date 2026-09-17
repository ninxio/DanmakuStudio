//! Loading belongs to a playlist entry, not a filename or a nonzero duration.
#[derive(Default)]
pub(super) struct MediaLoad {
    pub revision: u64,
    pub state: LoadState,
    expected_entry: Option<i64>,
    active_entry: Option<i64>,
    pub pending_seek: Option<u64>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) enum LoadState {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed,
}

impl MediaLoad {
    pub fn begin(&mut self) {
        self.revision += 1;
        self.state = LoadState::Loading;
        self.expected_entry = None;
        self.active_entry = None;
        self.pending_seek = None;
    }

    pub fn bind_entry(&mut self, entry: Option<i64>) -> Result<(), String> {
        self.expected_entry = entry;
        if entry.is_none() {
            self.fail();
            return Err("libmpv 未返回新媒体的播放条目标识。".into());
        }
        Ok(())
    }

    pub fn started(&mut self, entry: i64) {
        self.active_entry = Some(entry);
    }

    pub fn loaded(&mut self) {
        if self.state == LoadState::Loading
            && self.active_entry.is_some()
            && self.active_entry == self.expected_entry
        {
            self.state = LoadState::Ready;
        }
    }

    pub fn ended(&mut self, entry: i64, reason: i32, redirect_entry: i64) -> bool {
        if Some(entry) != self.expected_entry {
            return false;
        }
        if reason == 5 && redirect_entry >= 0 {
            self.expected_entry = Some(redirect_entry);
            self.active_entry = None;
            self.state = LoadState::Loading;
            return false;
        }
        if reason == 4 || self.state == LoadState::Loading {
            self.fail();
            return true;
        }
        // keep-open retains the loaded file at EOF; it can still seek/replay.
        false
    }

    pub fn fail(&mut self) {
        self.state = LoadState::Failed;
        self.pending_seek = None;
    }

    pub fn ready(&self) -> bool {
        self.state == LoadState::Ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_name_reload_ignores_old_loaded_and_end_events() {
        let mut load = MediaLoad::default();
        load.begin();
        load.bind_entry(Some(10)).unwrap();
        load.started(10);
        load.loaded();
        assert!(load.ready());
        load.begin();
        load.bind_entry(Some(11)).unwrap();
        load.started(10);
        load.loaded();
        assert!(!load.ready());
        assert!(!load.ended(10, 4, -1));
        load.started(11);
        load.loaded();
        assert!(load.ready());
        assert_eq!(load.revision, 2);
    }

    #[test]
    fn live_ready_does_not_require_duration_and_seek_keeps_only_latest() {
        let mut load = MediaLoad::default();
        load.begin();
        load.bind_entry(Some(1)).unwrap();
        load.pending_seek = Some(1000);
        load.pending_seek = Some(2000);
        load.started(1);
        load.loaded();
        assert!(load.ready());
        assert_eq!(load.pending_seek.take(), Some(2000));
        assert!(!load.ended(1, 0, -1));
        assert!(load.ready());
    }

    #[test]
    fn failed_and_redirected_loads_remain_bound_to_their_entries() {
        let mut load = MediaLoad::default();
        load.begin();
        load.bind_entry(Some(1)).unwrap();
        load.started(1);
        assert!(!load.ended(1, 5, 2));
        load.loaded();
        assert!(!load.ready());
        load.started(2);
        assert!(load.ended(2, 4, -1));
        assert_eq!(load.state, LoadState::Failed);
        load.loaded();
        assert!(!load.ready());
    }
}
