//! Capture only root-level metadata while the existing strict parser scans XML once.
//! Namespace interpretation and semantic validation are shared by both frontend importers.
use quick_xml::events::BytesStart;

#[derive(Default)]
pub(super) struct MetadataFragment {
    root: String,
    root_name: String,
    fragments: String,
    pending: Option<usize>,
}

impl MetadataFragment {
    pub(super) fn start(
        &mut self,
        start: &BytesStart<'_>,
        depth: usize,
        from: usize,
        to: usize,
        xml: &str,
        empty: bool,
    ) -> Result<(), String> {
        if depth == 0 {
            self.root = format!("<{}>", String::from_utf8_lossy(start.as_ref()));
            self.root_name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
        }
        if depth == 1 && matches!(start.local_name().as_ref(), b"meta" | b"metadata") {
            self.pending = Some(from);
            if empty {
                self.end(2, to, xml)?;
            }
        }
        Ok(())
    }

    pub(super) fn end(&mut self, depth: usize, to: usize, xml: &str) -> Result<(), String> {
        if depth == 2 {
            if let Some(from) = self.pending.take() {
                if self.root.len() + self.fragments.len() + to - from + self.root_name.len() + 3
                    > 1024 * 1024
                {
                    return Err("XML 媒体元数据超过 1 MiB 限制。".into());
                }
                self.fragments.push_str(&xml[from..to]);
            }
        }
        Ok(())
    }

    pub(super) fn finish(self) -> Option<String> {
        if self.fragments.is_empty() {
            None
        } else {
            Some(format!(
                "{}{}</{}>",
                self.root, self.fragments, self.root_name
            ))
        }
    }
}
