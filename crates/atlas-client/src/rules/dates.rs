//! Read a due date the way an integration sends one (`parseDue` in `packages/sdk/src/dates.ts`).

use jiff::tz::TimeZone;
use serde_json::Value;

use super::zoned::{add_days, days_in_month, end_of_day, make_instant, MAX_DATE_MS};
use crate::error::Error;

fn unreadable(value: &str) -> Error {
    Error::atlas(
        "bad_input",
        format!("cannot read the date \"{value}\" (use YYYY-MM-DD, YYYY-MM-DDTHH:MM, ISO 8601 or unix ms)"),
    )
}

fn check_ms(ms: f64) -> Result<i64, Error> {
    if !ms.is_finite() || ms.abs() > MAX_DATE_MS as f64 {
        return Err(Error::atlas(
            "bad_input",
            format!("not a timestamp: {}", js_number(ms)),
        ));
    }
    Ok(ms as i64)
}

fn js_number(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        f.to_string()
    }
}

/// Fixed-width ASCII digits.
fn digits(s: &str, n: usize) -> Option<i64> {
    (s.len() == n && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
}

fn check_parts(value: &str, y: i64, m: i64, d: i64, h: i64, min: i64, s: i64) -> Result<(), Error> {
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) || h > 23 || min > 59 || s > 59 {
        return Err(unreadable(value));
    }
    Ok(())
}

/// `YYYY-MM-DD`.
fn date_part(s: &str) -> Option<(i64, i64, i64)> {
    let mut it = s.split('-');
    let (y, m, d) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    Some((digits(y, 4)?, digits(m, 2)?, digits(d, 2)?))
}

/// An ISO 8601 instant with `Z` or an offset, as `Date.parse` reads the forms an integration sends.
fn parse_instant(text: &str) -> Option<i64> {
    let ts: jiff::Timestamp = text.parse().ok()?;
    Some(ts.as_millisecond())
}

/// `null`, `""` or `none`: no date. A number or digits: unix ms. `YYYY-MM-DD`, `today`,
/// `tomorrow`: that day at the default due time (23:59). `YYYY-MM-DDTHH:MM[:SS]`: that wall time;
/// with `Z` or an offset, that instant.
pub fn parse_due(value: &Value, tz: &TimeZone, now: i64) -> Result<Option<i64>, Error> {
    let text = match value {
        Value::Null => return Ok(None),
        Value::Number(n) => return check_ms(n.as_f64().unwrap_or(f64::NAN)).map(Some),
        Value::String(s) => s.as_str(),
        other => return Err(unreadable(&other.to_string())),
    };
    let original = text;
    let text = text.trim();
    let lower = text.to_lowercase();
    if lower.is_empty() || lower == "none" {
        return Ok(None);
    }
    if text.bytes().all(|b| b.is_ascii_digit()) {
        return check_ms(text.parse::<f64>().unwrap_or(f64::INFINITY)).map(Some);
    }
    if lower == "today" {
        return Ok(Some(end_of_day(now, tz)));
    }
    if lower == "tomorrow" {
        return Ok(Some(end_of_day(add_days(now, 1, tz), tz)));
    }
    if let Some((y, m, d)) = date_part(text) {
        check_parts(original, y, m, d, 0, 0, 0)?;
        return Ok(Some(end_of_day(
            make_instant(y, m - 1, d, 12, 0, 0, tz),
            tz,
        )));
    }
    if text.len() >= 16 && text.is_char_boundary(10) {
        let (date, rest) = text.split_at(10);
        if let (Some((y, m, d)), Some(sep)) = (date_part(date), rest.chars().next()) {
            if sep == 'T' || sep == ' ' {
                let time = &rest[1..];
                let parts: Vec<&str> = time.split(':').collect();
                let hms = match parts.as_slice() {
                    [h, mi] => digits(h, 2).zip(digits(mi, 2)).map(|(h, mi)| (h, mi, 0)),
                    [h, mi, s] => match (digits(h, 2), digits(mi, 2), digits(s, 2)) {
                        (Some(h), Some(mi), Some(s)) => Some((h, mi, s)),
                        _ => None,
                    },
                    _ => None,
                };
                if let Some((h, mi, s)) = hms {
                    check_parts(original, y, m, d, h, mi, s)?;
                    return Ok(Some(make_instant(y, m - 1, d, h, mi, s, tz)));
                }
            }
        }
    }
    let iso =
        text.get(..10).and_then(date_part).is_some() && text.as_bytes().get(10) == Some(&b'T');
    if iso {
        if let Some(ms) = parse_instant(text) {
            return Ok(Some(ms));
        }
    }
    Err(unreadable(original))
}
