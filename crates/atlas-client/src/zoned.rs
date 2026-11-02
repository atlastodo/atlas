//! Time-zone-aware day math (`zonedTime.ts`), the instant to calendar-day mapping every rule uses.
//! Instants are Unix milliseconds within the JavaScript `Date` range (|ms| ≤ 8.64e15); months are
//! 0-based, as in JavaScript.

use jiff::tz::TimeZone;
use jiff::Timestamp;

pub const DAY_MS: i64 = 86_400_000;
pub const MAX_DATE_MS: i64 = 8_640_000_000_000_000;
const GAP_PROBE_MS: i64 = DAY_MS;

pub const DEFAULT_DUE_HOUR: i64 = 23;
pub const DEFAULT_DUE_MINUTE: i64 = 59;

/// A zone by IANA name; the system's (or UTC) when blank or unknown (`resolveTimeZone`).
pub fn resolve_time_zone(name: Option<&str>) -> TimeZone {
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        if let Ok(tz) = TimeZone::get(name) {
            return tz;
        }
    }
    TimeZone::try_system().unwrap_or(TimeZone::UTC)
}

/// Whether the zone name is one this build knows.
pub fn is_valid_time_zone(name: &str) -> bool {
    TimeZone::get(name).is_ok()
}

fn idiv(a: i64, b: i64) -> i64 {
    a.div_euclid(b)
}

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let yy = if m <= 2 { y - 1 } else { y };
    let era = idiv(if yy >= 0 { yy } else { yy - 399 }, 400);
    let yoe = yy - era * 400;
    let doy = idiv(153 * (if m > 2 { m - 3 } else { m + 9 }) + 2, 5) + d - 1;
    let doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let zz = z + 719_468;
    let era = idiv(if zz >= 0 { zz } else { zz - 146_096 }, 146_097);
    let doe = zz - era * 146_097;
    let yoe = idiv(
        doe - idiv(doe, 1460) + idiv(doe, 36_524) - idiv(doe, 146_096),
        365,
    );
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100));
    let mp = idiv(5 * doy + 2, 153);
    let d = doy - idiv(153 * mp + 2, 5) + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.UTC(year, month0, day, hour, minute, second)`, overflowing fields carrying over.
pub fn date_utc(year: i64, month0: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let y = year + idiv(month0, 12);
    let m = month0.rem_euclid(12) + 1;
    let days = days_from_civil(y, m, 1) + day - 1;
    days * DAY_MS + hour * 3_600_000 + minute * 60_000 + second * 1000
}

/// Days in a month (1-based).
pub fn days_in_month(y: i64, m: i64) -> i64 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    days_from_civil(ny, nm, 1) - days_from_civil(y, m, 1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZonedParts {
    pub year: i64,
    /// 0-based.
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    /// Sunday = 0.
    pub weekday: i64,
}

/// The zone's UTC offset at `ms`, in seconds. Instants past the range of the zone database are
/// moved by whole 400-year Gregorian cycles (which repeat weekdays, so DST rules too) first.
fn offset_seconds(ms: i64, tz: &TimeZone) -> i64 {
    const CYCLE_MS: i64 = 146_097 * DAY_MS;
    const LIMIT: i64 = 200_000_000_000_000;
    let shifted = if ms > LIMIT {
        ms - (ms - LIMIT).div_euclid(CYCLE_MS).saturating_add(1) * CYCLE_MS
    } else if ms < -LIMIT {
        ms + (-LIMIT - ms).div_euclid(CYCLE_MS).saturating_add(1) * CYCLE_MS
    } else {
        ms
    };
    match Timestamp::from_millisecond(shifted) {
        Ok(ts) => i64::from(tz.to_offset(ts).seconds()),
        Err(_) => 0,
    }
}

/// The wall-clock parts `ms` shows in the zone; `None` outside the `Date` range.
pub fn zoned_parts(ms: i64, tz: &TimeZone) -> Option<ZonedParts> {
    if ms.abs() > MAX_DATE_MS {
        return None;
    }
    let local_s = ms.div_euclid(1000) + offset_seconds(ms, tz);
    let days = local_s.div_euclid(86_400);
    let secs = local_s.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    Some(ZonedParts {
        year,
        month: month - 1,
        day,
        hour: secs / 3600,
        minute: secs / 60 % 60,
        second: secs % 60,
        weekday: (days + 4).rem_euclid(7),
    })
}

fn offset_ms(ms: i64, tz: &TimeZone) -> i64 {
    match zoned_parts(ms, tz) {
        Some(p) => date_utc(p.year, p.month, p.day, p.hour, p.minute, p.second) - ms,
        None => 0,
    }
}

/// The instant a wall-clock time shows in the zone (`makeInstant`). A time skipped by a DST gap
/// resolves forward by the gap's length (02:30 on a spring-forward night is 03:30).
pub fn make_instant(
    year: i64,
    month0: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    tz: &TimeZone,
) -> i64 {
    let utc_guess = date_utc(year, month0, day, hour, minute, second);
    let offset = offset_ms(utc_guess, tz);
    let mut instant = utc_guess - offset;
    let offset2 = offset_ms(instant, tz);
    if offset2 != offset {
        instant = utc_guess - offset2;
    }
    if offset_ms(instant, tz) == utc_guess - instant {
        return instant;
    }
    let before = offset_ms(instant - GAP_PROBE_MS, tz);
    let forward = utc_guess - before;
    forward.max(instant)
}

pub fn start_of_day(ms: i64, tz: &TimeZone) -> i64 {
    match zoned_parts(ms, tz) {
        Some(p) => make_instant(p.year, p.month, p.day, 0, 0, 0, tz),
        None => ms,
    }
}

/// 23:59 that day: the app's default due time.
pub fn end_of_day(ms: i64, tz: &TimeZone) -> i64 {
    match zoned_parts(ms, tz) {
        Some(p) => make_instant(
            p.year,
            p.month,
            p.day,
            DEFAULT_DUE_HOUR,
            DEFAULT_DUE_MINUTE,
            0,
            tz,
        ),
        None => ms,
    }
}

/// Calendar days from `now`'s day to `due`'s.
pub fn day_offset(due: i64, now: i64, tz: &TimeZone) -> i64 {
    let diff = (start_of_day(due, tz) - start_of_day(now, tz)) as f64 / DAY_MS as f64;
    // Math.round: halves round up.
    (diff + 0.5).floor() as i64
}

/// The start of the day `n` days after `ms`'s.
pub fn add_days(ms: i64, n: i64, tz: &TimeZone) -> i64 {
    match zoned_parts(ms, tz) {
        Some(p) => make_instant(p.year, p.month, p.day + n, 0, 0, 0, tz),
        None => ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_boundaries_follow_the_zone() {
        let cph = resolve_time_zone(Some("Europe/Copenhagen"));
        // 2026-03-29 is the spring-forward day in Copenhagen: 02:30 does not exist.
        let at = make_instant(2026, 2, 29, 2, 30, 0, &cph);
        let p = zoned_parts(at, &cph).unwrap();
        assert_eq!((p.hour, p.minute), (3, 30));
        assert_eq!(end_of_day(at, &cph), date_utc(2026, 2, 29, 21, 59, 0));
        let ny = resolve_time_zone(Some("America/New_York"));
        let now = date_utc(2026, 6, 15, 12, 0, 0);
        assert_eq!(end_of_day(now, &ny), date_utc(2026, 6, 16, 3, 59, 0));
        assert_eq!(day_offset(add_days(now, 3, &ny), now, &ny), 3);
        let utc = resolve_time_zone(Some("UTC"));
        assert_eq!(zoned_parts(0, &utc).unwrap().weekday, 4);
        assert_eq!(zoned_parts(-1, &utc).unwrap().second, 59);
        assert!(zoned_parts(MAX_DATE_MS + 1, &utc).is_none());
        let far = zoned_parts(MAX_DATE_MS, &ny).unwrap();
        assert_eq!(far.year, 275_760);
    }
}
