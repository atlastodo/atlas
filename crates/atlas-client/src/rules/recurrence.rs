//! Task recurrence (`recurrence.ts`, asserted against `test-vectors/recurrence_vectors.json`): a
//! compact RRULE subset plus `MODE=COMPLETION`, stepped on wall-clock dates so the time of day
//! does not drift across DST.

use jiff::tz::TimeZone;

use super::zoned::{
    civil_from_days, days_from_civil, days_in_month, make_instant, zoned_parts, MAX_DATE_MS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    fn upper(self) -> &'static str {
        match self {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecurMode {
    OnSchedule,
    AfterCompletion,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: i64,
    /// Monday = 0, sorted and unique.
    pub byday: Vec<i64>,
    pub bymonthday: Option<i64>,
    pub mode: RecurMode,
    /// `BYHOUR`/`BYMINUTE`: kept only while an occurrence sits in a DST gap.
    pub at: Option<(i64, i64)>,
}

pub const MAX_INTERVAL: i64 = 1000;
const WEEKDAY_TOKENS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

fn is_ascii_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')
}

fn trim_ascii(s: &str) -> &str {
    s.trim_matches(is_ascii_ws)
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `Number` of an all-digit string, saturating far above every bound checked.
fn number(s: &str) -> i64 {
    s.parse::<i64>().unwrap_or(i64::MAX)
}

pub fn parse_rule(input: &str) -> Option<Rule> {
    let mut freq = None;
    let mut interval = 1;
    let mut byday = Vec::new();
    let mut bymonthday = None;
    let (mut byhour, mut byminute) = (None, None);
    let mut mode = RecurMode::OnSchedule;
    for raw in input.split(';') {
        let part = trim_ascii(raw);
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=')?;
        let key = trim_ascii(key).to_ascii_uppercase();
        let value = trim_ascii(value).to_ascii_uppercase();
        match key.as_str() {
            "FREQ" => {
                freq = Some(match value.as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                })
            }
            "INTERVAL" => {
                if !digits(&value) {
                    return None;
                }
                let n = number(&value);
                if !(1..=MAX_INTERVAL).contains(&n) {
                    return None;
                }
                interval = n;
            }
            "BYDAY" => {
                for tok in value.split(',') {
                    let tok = trim_ascii(tok);
                    if tok.is_empty() {
                        continue;
                    }
                    byday.push(WEEKDAY_TOKENS.iter().position(|t| *t == tok)? as i64);
                }
            }
            "BYMONTHDAY" => {
                if !digits(&value) {
                    return None;
                }
                let n = number(&value);
                if !(1..=31).contains(&n) {
                    return None;
                }
                bymonthday = Some(n);
            }
            "BYHOUR" | "BYMINUTE" => {
                if !digits(&value) || value.len() > 2 {
                    return None;
                }
                let n = number(&value);
                if n > if key == "BYHOUR" { 23 } else { 59 } {
                    return None;
                }
                if key == "BYHOUR" {
                    byhour = Some(n);
                } else {
                    byminute = Some(n);
                }
            }
            "MODE" => {
                mode = match value.as_str() {
                    "SCHEDULE" => RecurMode::OnSchedule,
                    "COMPLETION" => RecurMode::AfterCompletion,
                    _ => return None,
                }
            }
            _ => return None,
        }
    }
    let freq = freq?;
    if bymonthday.is_some()
        && freq != Freq::Monthly
        && !(freq == Freq::Yearly && bymonthday == Some(29))
    {
        return None;
    }
    if byhour.is_none() != byminute.is_none() {
        return None;
    }
    byday.sort_unstable();
    byday.dedup();
    Some(Rule {
        freq,
        interval,
        byday,
        bymonthday,
        mode,
        at: byhour.zip(byminute),
    })
}

fn month_day_applies(rule: &Rule) -> Option<i64> {
    if matches!(rule.freq, Freq::Monthly | Freq::Yearly) && rule.mode == RecurMode::OnSchedule {
        rule.bymonthday
    } else {
        None
    }
}

pub fn rule_to_string(rule: &Rule) -> String {
    let mut parts = vec![format!("FREQ={}", rule.freq.upper())];
    if rule.interval != 1 {
        parts.push(format!("INTERVAL={}", rule.interval));
    }
    if rule.freq == Freq::Weekly && !rule.byday.is_empty() {
        let days: Vec<&str> = rule
            .byday
            .iter()
            .map(|d| WEEKDAY_TOKENS[*d as usize])
            .collect();
        parts.push(format!("BYDAY={}", days.join(",")));
    }
    if let Some(d) = month_day_applies(rule) {
        parts.push(format!("BYMONTHDAY={d}"));
    }
    if let Some((h, m)) = rule.at {
        parts.push(format!("BYHOUR={h}"));
        parts.push(format!("BYMINUTE={m}"));
    }
    if rule.mode == RecurMode::AfterCompletion {
        parts.push("MODE=COMPLETION".into());
    }
    parts.join(";")
}

/// A monthly rule on schedule takes the due date's day as `BYMONTHDAY`; a time of day the due date
/// does not show is dropped.
pub fn anchor_month_day(rule: &str, due_ms: i64, tz: &TimeZone) -> String {
    with_month_day(&with_time_fitting(rule, due_ms, tz), due_ms, tz, false)
}

fn with_time_fitting(rule: &str, due_ms: i64, tz: &TimeZone) -> String {
    let Some(parsed) = parse_rule(rule) else {
        return rule.to_owned();
    };
    let Some((hour, minute)) = parsed.at else {
        return rule.to_owned();
    };
    if let Some(p) = zoned_parts(due_ms, tz) {
        let at = make_instant(p.year, p.month, p.day, hour, minute, p.second, tz);
        if at + due_ms.rem_euclid(1000) == due_ms {
            return rule.to_owned();
        }
    }
    rule_to_string(&Rule { at: None, ..parsed })
}

/// For rules stored before `BYMONTHDAY` existed.
pub fn pin_month_day(rule: &str, due_ms: i64, tz: &TimeZone) -> String {
    with_month_day(rule, due_ms, tz, true)
}

fn with_month_day(rule: &str, due_ms: i64, tz: &TimeZone, only_if_missing: bool) -> String {
    let Some(parsed) = parse_rule(rule) else {
        return rule.to_owned();
    };
    if parsed.mode != RecurMode::OnSchedule || !matches!(parsed.freq, Freq::Monthly | Freq::Yearly)
    {
        return rule.to_owned();
    }
    let Some(p) = zoned_parts(due_ms, tz) else {
        return rule.to_owned();
    };
    if only_if_missing && parsed.bymonthday.is_some() {
        return rule.to_owned();
    }
    let last_day = days_in_month(p.year, p.month + 1);
    if parsed.bymonthday.is_some_and(|d| d.min(last_day) == p.day) {
        return rule.to_owned();
    }
    if parsed.freq == Freq::Yearly {
        let bymonthday = (p.month == 1 && p.day == 29).then_some(29);
        return if bymonthday == parsed.bymonthday {
            rule.to_owned()
        } else {
            rule_to_string(&Rule {
                bymonthday,
                ..parsed
            })
        };
    }
    rule_to_string(&Rule {
        bymonthday: Some(p.day),
        ..parsed
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilDateTime {
    pub year: i64,
    /// 1-based.
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilDate {
    pub year: i64,
    pub month: i64,
    pub day: i64,
}

const MIN_YEAR: i64 = -(1 << 31);
const MAX_YEAR: i64 = (1 << 31) - 1;

fn weekday_mon0(day: i64) -> i64 {
    (day + 3).rem_euclid(7)
}

fn add_months(day: i64, months: i64, month_day: Option<i64>) -> i64 {
    let (y, m, d) = civil_from_days(day);
    let total = m - 1 + months;
    let ny = y + total.div_euclid(12);
    let nm = total.rem_euclid(12) + 1;
    let nd = month_day.unwrap_or(d).min(days_in_month(ny, nm));
    days_from_civil(ny, nm, nd)
}

fn date_to_days(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    if !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn next_byday(byday: &[i64], interval: i64, anchor_day: i64, base: i64) -> i64 {
    let ref_week = anchor_day - weekday_mon0(anchor_day);
    let start = base + 1;
    let start_wd = weekday_mon0(start);
    let week = (start - start_wd - ref_week).div_euclid(7);
    if week >= 0 && week % interval == 0 {
        if let Some(wd) = byday.iter().find(|d| **d >= start_wd) {
            return start - start_wd + wd;
        }
    }
    let next_week = if week < 0 {
        0
    } else {
        (week.div_euclid(interval) + 1) * interval
    };
    ref_week + next_week * 7 + byday[0]
}

/// The next occurrence on wall-clock dates; `anchor` is the due date, `from` the completion day.
pub fn next_occurrence_civil(
    rule: &str,
    anchor: CivilDateTime,
    from: CivilDate,
) -> Option<CivilDateTime> {
    let parsed = parse_rule(rule)?;
    let (hour, minute) = parsed.at.unwrap_or((anchor.hour, anchor.minute));
    if !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&anchor.second)
        || !(0..=999).contains(&anchor.millisecond)
    {
        return None;
    }
    let anchor_day = date_to_days(anchor.year, anchor.month, anchor.day)?;
    let base = match parsed.mode {
        RecurMode::OnSchedule => anchor_day,
        RecurMode::AfterCompletion => date_to_days(from.year, from.month, from.day)?,
    };
    let interval = parsed.interval;
    let next = match parsed.freq {
        Freq::Daily => base + interval,
        Freq::Weekly if parsed.byday.is_empty() => base + interval * 7,
        Freq::Weekly => next_byday(&parsed.byday, interval, anchor_day, base),
        Freq::Monthly => add_months(base, interval, month_day_applies(&parsed)),
        Freq::Yearly => {
            let in_february = civil_from_days(base).1 == 2;
            add_months(
                base,
                interval * 12,
                month_day_applies(&parsed).filter(|_| in_february),
            )
        }
    };
    let (year, month, day) = civil_from_days(next);
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return None;
    }
    Some(CivilDateTime {
        year,
        month,
        day,
        hour,
        minute,
        second: anchor.second,
        millisecond: anchor.millisecond,
    })
}

/// [`next_occurrence_civil`] for instants read as wall-clock time in the zone.
pub fn next_occurrence(rule: &str, anchor_ms: i64, from_ms: i64, tz: &TimeZone) -> Option<i64> {
    let a = zoned_parts(anchor_ms, tz)?;
    let f = zoned_parts(from_ms, tz)?;
    let next = next_occurrence_civil(
        rule,
        CivilDateTime {
            year: a.year,
            month: a.month + 1,
            day: a.day,
            hour: a.hour,
            minute: a.minute,
            second: a.second,
            millisecond: anchor_ms.rem_euclid(1000),
        },
        CivilDate {
            year: f.year,
            month: f.month + 1,
            day: f.day,
        },
    )?;
    let ms = make_instant(
        next.year,
        next.month - 1,
        next.day,
        next.hour,
        next.minute,
        next.second,
        tz,
    )
    .checked_add(next.millisecond)?;
    (ms.abs() <= MAX_DATE_MS).then_some(ms)
}

/// The occurrence after `due_ms` and the rule to store with it (`advanceSeries`).
pub fn advance_series(
    rule: &str,
    due_ms: i64,
    from_ms: i64,
    tz: &TimeZone,
) -> Option<(i64, String)> {
    let pinned = pin_month_day(rule, due_ms, tz);
    let next = next_occurrence(&pinned, due_ms, from_ms, tz)?;
    let parsed = parse_rule(&pinned)?;
    let due = zoned_parts(due_ms, tz)?;
    let want = parsed.at.unwrap_or((due.hour, due.minute));
    let shown = zoned_parts(next, tz)?;
    let at = if (shown.hour, shown.minute) == want {
        None
    } else {
        Some(want)
    };
    if parsed.at == at {
        Some((next, pinned))
    } else {
        Some((next, rule_to_string(&Rule { at, ..parsed })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn civil(local: &str) -> CivilDateTime {
        let (date, time) = local.split_once('T').unwrap();
        let (time, ms) = time.split_once('.').unwrap_or((time, "0"));
        let neg = date.starts_with('-');
        let d: Vec<i64> = date
            .trim_start_matches('-')
            .split('-')
            .map(|x| x.parse().unwrap())
            .collect();
        let t: Vec<i64> = time.split(':').map(|x| x.parse().unwrap()).collect();
        CivilDateTime {
            year: if neg { -d[0] } else { d[0] },
            month: d[1],
            day: d[2],
            hour: t[0],
            minute: t[1],
            second: t[2],
            millisecond: ms.parse().unwrap(),
        }
    }

    #[test]
    fn recurrence_parity_vectors() {
        let path = format!(
            "{}/../../test-vectors/recurrence_vectors.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let rule = v["rule"].as_str().unwrap();
            let tz = TimeZone::get(v["tz"].as_str().unwrap()).unwrap();
            let got = next_occurrence(
                rule,
                v["anchor"].as_i64().unwrap(),
                v["from"].as_i64().unwrap(),
                &tz,
            );
            assert_eq!(got, v["expected"].as_i64(), "instants: {name}");
            let anchor = civil(v["anchor_local"].as_str().unwrap());
            let from = civil(v["from_local"].as_str().unwrap());
            let got = next_occurrence_civil(
                rule,
                anchor,
                CivilDate {
                    year: from.year,
                    month: from.month,
                    day: from.day,
                },
            );
            let expected = v["expected_local"].as_str().map(civil);
            assert_eq!(got, expected, "civil: {name}");
        }
        for p in fixture["parse"].as_array().unwrap() {
            let rule = p["rule"].as_str().unwrap();
            assert_eq!(
                parse_rule(rule).is_some(),
                p["valid"].as_bool().unwrap(),
                "parse {rule:?}"
            );
        }
    }

    #[test]
    fn rules_round_trip() {
        for s in [
            "FREQ=DAILY",
            "FREQ=WEEKLY;INTERVAL=2",
            "FREQ=WEEKLY;BYDAY=MO,WE",
            "FREQ=MONTHLY;MODE=COMPLETION",
            "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=31",
        ] {
            assert_eq!(rule_to_string(&parse_rule(s).unwrap()), s);
        }
        assert_eq!(
            rule_to_string(&parse_rule("FREQ=MONTHLY;BYMONTHDAY=31;MODE=COMPLETION").unwrap()),
            "FREQ=MONTHLY;MODE=COMPLETION"
        );
    }
}
