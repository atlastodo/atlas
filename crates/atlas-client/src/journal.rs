//! Atlas Journal entries (`journal.entry`, `manifests/journal.json`) for a session of the journal
//! app. Every field is encrypted (the manifest lists no plaintext field), under the journal app
//! key the token carries.
//!
//! An entry's fields, as this client writes and reads them (see `docs/integrations.md`):
//! - `date`: the day the entry is about, `YYYY-MM-DD` (a calendar date, no zone).
//! - `title`, `body`: text; either may be empty, not both.
//! - `mood`: 1 (awful) to 5 (great), or null.
//! - `tags`: a list of distinct, non-empty strings.
//! - `created_at`, `updated_at`: unix ms; `deleted_at`: unix ms once in the trash, else null.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::client::AtlasClient;
use crate::error::{Error, Result};
use crate::rules::zoned::{civil_from_days, days_from_civil, days_in_month, zoned_parts};
use crate::session::app_name;
use atlas_core::EntityKind;
use jiff::tz::TimeZone;

pub const JOURNAL_APP: &str = "journal";

/// A journal entry as integrations see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JournalEntry {
    pub id: String,
    pub date: String,
    pub title: String,
    pub body: String,
    pub mood: Option<u8>,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct JournalQuery {
    /// Entries dated on or after this day (`YYYY-MM-DD`).
    pub from: Option<String>,
    /// Entries dated on or before this day.
    pub to: Option<String>,
    /// A tag, case-insensitive.
    pub tag: Option<String>,
    /// Case-insensitive substring of the title or body.
    pub search: Option<String>,
}

/// The fields of a new entry, or of a change to one: `None` is "not given"; in a change,
/// `mood: Some(None)` clears the mood.
#[derive(Debug, Clone, Default)]
pub struct JournalFields {
    pub date: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub mood: Option<Option<u8>>,
    pub tags: Option<Vec<String>>,
}

fn bad(message: impl Into<String>) -> Error {
    Error::atlas("bad_input", message)
}

/// The calendar day `YYYY-MM-DD` names, when it is one.
fn civil(text: &str) -> Option<(i64, i64, i64)> {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = &text[r];
        s.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    ((1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)).then_some((y, m, d))
}

fn format_day(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// An entry date: `YYYY-MM-DD`, or `today`, `yesterday` or `tomorrow` in `tz` at `now`.
pub fn parse_entry_date(text: &str, tz: &TimeZone, now: i64) -> Result<String> {
    let t = text.trim();
    let offset = match t.to_ascii_lowercase().as_str() {
        "today" => Some(0),
        "yesterday" => Some(-1),
        "tomorrow" => Some(1),
        _ => None,
    };
    if let Some(offset) = offset {
        let p = zoned_parts(now, tz).ok_or_else(|| bad("the clock is out of range"))?;
        let days = days_from_civil(p.year, p.month + 1, p.day);
        return Ok(format_day(days + offset));
    }
    if civil(t).is_none() {
        return Err(bad(format!(
            "\"{text}\" is not a date (YYYY-MM-DD, today, yesterday or tomorrow)"
        )));
    }
    Ok(t.to_owned())
}

/// A mood: a whole number from 1 to 5.
pub fn check_mood(v: &Value) -> Result<u8> {
    match v.as_f64() {
        Some(f) if f.fract() == 0.0 && (1.0..=5.0).contains(&f) => Ok(f as u8),
        _ => Err(bad("mood must be 1 (awful) to 5 (great)")),
    }
}

/// Tags trimmed, without empty ones or repeats (case-insensitive), in order.
pub fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if !t.is_empty() && !out.iter().any(|o| o.to_lowercase() == t.to_lowercase()) {
            out.push(t.to_owned());
        }
    }
    out
}

fn int(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
}

/// Read an entry's fields, tolerating values of the wrong shape (another client's).
pub fn to_entry(id: &str, f: &Map<String, Value>) -> JournalEntry {
    let text = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    JournalEntry {
        id: id.to_owned(),
        date: text("date"),
        title: text("title"),
        body: text("body"),
        mood: f.get("mood").and_then(|m| check_mood(m).ok()),
        tags: f
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        created_at: int(f.get("created_at")).unwrap_or(0),
        updated_at: int(f.get("updated_at")).unwrap_or(0),
        deleted_at: int(f.get("deleted_at")),
    }
}

impl AtlasClient {
    fn require_journal(&self) -> Result<()> {
        let app = &self.session().app;
        if app == JOURNAL_APP {
            return Ok(());
        }
        Err(Error::atlas(
            "wrong_app",
            format!(
                "journal entries need a session of {}, this one is {}",
                app_name(JOURNAL_APP),
                app_name(app)
            ),
        ))
    }

    fn raw_entry(&self, id: &str) -> Result<JournalEntry> {
        self.require_journal()?;
        self.session()
            .store
            .get(EntityKind::JournalEntry, id)
            .map(|f| to_entry(id, &f))
            .ok_or_else(|| {
                Error::atlas(
                    "unknown_journal_entry",
                    format!("no journal entry \"{id}\""),
                )
            })
    }

    /// One entry by id, trashed or not.
    pub fn journal_entry(&self, id: &str) -> Result<JournalEntry> {
        self.raw_entry(id)
    }

    /// Entries not in the trash, filtered by `query`: newest date first, then newest written.
    pub fn journal_entries(&self, query: &JournalQuery) -> Result<Vec<JournalEntry>> {
        self.require_journal()?;
        let (tz, now) = (self.time_zone().clone(), self.now());
        let day = |d: &Option<String>| -> Result<Option<String>> {
            d.as_deref()
                .filter(|d| !d.is_empty())
                .map(|d| parse_entry_date(d, &tz, now))
                .transpose()
        };
        let (from, to) = (day(&query.from)?, day(&query.to)?);
        let tag = query
            .tag
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(str::to_lowercase);
        let search = query
            .search
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let mut out: Vec<JournalEntry> = self
            .session()
            .store
            .list(EntityKind::JournalEntry)
            .iter()
            .map(|e| to_entry(&e.id, &e.fields))
            .filter(|e| e.deleted_at.is_none())
            .filter(|e| from.as_ref().is_none_or(|f| e.date >= *f))
            .filter(|e| to.as_ref().is_none_or(|t| e.date <= *t))
            .filter(|e| {
                tag.as_ref()
                    .is_none_or(|t| e.tags.iter().any(|x| x.to_lowercase() == *t))
            })
            .filter(|e| {
                search.as_ref().is_none_or(|s| {
                    e.title.to_lowercase().contains(s) || e.body.to_lowercase().contains(s)
                })
            })
            .collect();
        out.sort_by(|a, b| {
            b.date
                .cmp(&a.date)
                .then(b.created_at.cmp(&a.created_at))
                .then(a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// Write an entry and push it. `date` defaults to today in the client's zone.
    pub fn create_journal_entry(&mut self, input: JournalFields) -> Result<JournalEntry> {
        self.require_journal()?;
        let (tz, now) = (self.time_zone().clone(), self.now());
        let date = match input.date.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => parse_entry_date(d, &tz, now)?,
            None => parse_entry_date("today", &tz, now)?,
        };
        let title = input.title.unwrap_or_default().trim().to_owned();
        let body = input.body.unwrap_or_default();
        if title.is_empty() && body.trim().is_empty() {
            return Err(bad("a journal entry needs a title or a body"));
        }
        let tags = clean_tags(&input.tags.unwrap_or_default());
        let store = &mut self.session_mut().store;
        let id = store.new_entity_id();
        let fields: [(&str, Value); 7] = [
            ("date", date.into()),
            ("title", title.into()),
            ("body", body.into()),
            (
                "mood",
                input.mood.flatten().map_or(Value::Null, Value::from),
            ),
            ("tags", tags.into()),
            ("created_at", now.into()),
            ("updated_at", now.into()),
        ];
        for (field, value) in fields {
            store.set(EntityKind::JournalEntry, &id, field, value);
        }
        self.session_mut().push()?;
        self.raw_entry(&id)
    }

    /// Change an entry's given fields and push; unchanged values are skipped.
    pub fn update_journal_entry(&mut self, id: &str, patch: JournalFields) -> Result<JournalEntry> {
        let entry = self.raw_entry(id)?;
        let (tz, now) = (self.time_zone().clone(), self.now());
        let mut changes: Vec<(&str, Value)> = Vec::new();
        if let Some(d) = patch.date.as_deref() {
            let date = parse_entry_date(d, &tz, now)?;
            if date != entry.date {
                changes.push(("date", date.into()));
            }
        }
        let title = patch.title.map(|t| t.trim().to_owned());
        let next_title = title.clone().unwrap_or_else(|| entry.title.clone());
        let next_body = patch.body.clone().unwrap_or_else(|| entry.body.clone());
        if next_title.is_empty() && next_body.trim().is_empty() {
            return Err(bad("a journal entry needs a title or a body"));
        }
        if let Some(t) = title.filter(|t| *t != entry.title) {
            changes.push(("title", t.into()));
        }
        if let Some(b) = patch.body.filter(|b| *b != entry.body) {
            changes.push(("body", b.into()));
        }
        if let Some(m) = patch.mood.filter(|m| *m != entry.mood) {
            changes.push(("mood", m.map_or(Value::Null, Value::from)));
        }
        if let Some(t) = patch
            .tags
            .map(|t| clean_tags(&t))
            .filter(|t| *t != entry.tags)
        {
            changes.push(("tags", t.into()));
        }
        if changes.is_empty() {
            return Ok(entry);
        }
        changes.push(("updated_at", now.into()));
        let store = &mut self.session_mut().store;
        for (field, value) in changes {
            store.set(EntityKind::JournalEntry, id, field, value);
        }
        self.session_mut().push()?;
        self.raw_entry(id)
    }

    /// Move an entry to the trash (`deleted_at`); a no-op when it already is.
    pub fn delete_journal_entry(&mut self, id: &str) -> Result<()> {
        let entry = self.raw_entry(id)?;
        if entry.deleted_at.is_some() {
            return Ok(());
        }
        let now = self.now();
        let store = &mut self.session_mut().store;
        store.set(EntityKind::JournalEntry, id, "deleted_at", now.into());
        store.set(EntityKind::JournalEntry, id, "updated_at", now.into());
        self.session_mut().push()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn entry_dates_are_calendar_days() {
        let tz = TimeZone::get("Europe/Copenhagen").unwrap();
        // 2026-10-17T23:30:00Z is already the 18th in Copenhagen.
        let now = 1_792_279_800_000;
        assert_eq!(parse_entry_date("today", &tz, now).unwrap(), "2026-10-18");
        assert_eq!(
            parse_entry_date("Yesterday", &tz, now).unwrap(),
            "2026-10-17"
        );
        assert_eq!(
            parse_entry_date("tomorrow", &tz, now).unwrap(),
            "2026-10-19"
        );
        assert_eq!(
            parse_entry_date("today", &TimeZone::UTC, now).unwrap(),
            "2026-10-17"
        );
        assert_eq!(
            parse_entry_date(" 2024-02-29 ", &tz, now).unwrap(),
            "2024-02-29"
        );
        for bad in [
            "2025-02-29",
            "2026-13-01",
            "2026-1-01",
            "26-10-17",
            "next week",
            "",
        ] {
            assert!(parse_entry_date(bad, &tz, now).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn moods_tags_and_lenient_reads() {
        assert_eq!(check_mood(&json!(3)).unwrap(), 3);
        for bad in [json!(0), json!(6), json!(2.5), json!("3"), Value::Null] {
            assert!(check_mood(&bad).is_err(), "{bad}");
        }
        let tags = clean_tags(&["work".into(), " Work ".into(), "".into(), "travel".into()]);
        assert_eq!(tags, ["work", "travel"]);
        let fields = json!({
            "date": "2026-10-17", "title": 7, "body": "b", "mood": 9, "tags": ["a", 1],
            "created_at": 5, "deleted_at": null,
        });
        let e = to_entry("x", fields.as_object().unwrap());
        assert_eq!(
            (e.title.as_str(), e.mood, e.tags.len(), e.deleted_at),
            ("", None, 1, None)
        );
    }
}
