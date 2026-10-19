//! Natural-language quick add (`quickAddParse.ts`): "Buy milk tomorrow 5pm #groceries p1" into a
//! new task's fields. The vocabulary is the app's own lexicons (`quickAddLexicons.ts`), exported to
//! `quick_add_lexicons.json`. Spans count UTF-16 code units, as in JavaScript. The preview chips
//! the app shows are not produced.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use jiff::tz::TimeZone;
use serde::Serialize;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use super::filter::js_space;
use super::recurrence::{anchor_month_day, parse_rule, rule_to_string, Freq, RecurMode, Rule};
use super::zoned::{
    add_days, civil_from_days, date_utc, end_of_day, make_instant, start_of_day, zoned_parts,
    DAY_MS,
};

/// One language's vocabulary, every phrase already folded.
#[derive(Debug, Clone, Default)]
pub struct Lexicon {
    pub month_first: bool,
    pub one: Vec<String>,
    pub in_bare_unit: bool,
    pub glued_time_prefixes: Vec<String>,
    pub relative_days: Vec<(String, i64)>,
    pub weekdays: Vec<(String, i64)>,
    pub months: Vec<(String, i64)>,
    pub units: Vec<(String, Freq)>,
    pub in_prefixes: Vec<String>,
    pub next_prefixes: Vec<String>,
    pub next_suffixes: Vec<String>,
    pub this_prefixes: Vec<String>,
    pub lead_ins: Vec<String>,
    pub month_connectors: Vec<String>,
    pub every: Vec<String>,
    pub single: Vec<(String, Freq)>,
    pub from_completion: Vec<String>,
    pub time_prefixes: Vec<(String, bool)>,
    pub time_suffixes: Vec<String>,
    pub hour_letter: Option<String>,
    pub noon: Vec<String>,
    pub midnight: Vec<String>,
}

fn freq_of(s: &str) -> Freq {
    match s {
        "daily" => Freq::Daily,
        "weekly" => Freq::Weekly,
        "monthly" => Freq::Monthly,
        _ => Freq::Yearly,
    }
}

fn parse_lexicon(v: &Value) -> Lexicon {
    let list = |k: &str| -> Vec<String> {
        v[k].as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let pairs = |k: &str| -> Vec<(String, Value)> {
        v[k].as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| Some((p[0].as_str()?.to_owned(), p[1].clone())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let ints = |k: &str| {
        pairs(k)
            .into_iter()
            .map(|(p, n)| (p, n.as_i64().unwrap_or(0)))
            .collect()
    };
    let freqs = |k: &str| {
        pairs(k)
            .into_iter()
            .map(|(p, f)| (p, freq_of(f.as_str().unwrap_or(""))))
            .collect()
    };
    Lexicon {
        month_first: v["monthFirst"] == Value::Bool(true),
        one: list("one"),
        in_bare_unit: v["inBareUnit"] == Value::Bool(true),
        glued_time_prefixes: list("gluedTimePrefixes"),
        relative_days: ints("relativeDays"),
        weekdays: ints("weekdays"),
        months: ints("months"),
        units: freqs("units"),
        in_prefixes: list("inPrefixes"),
        next_prefixes: list("nextPrefixes"),
        next_suffixes: list("nextSuffixes"),
        this_prefixes: list("thisPrefixes"),
        lead_ins: list("leadIns"),
        month_connectors: list("monthConnectors"),
        every: list("every"),
        single: freqs("single"),
        from_completion: list("fromCompletion"),
        time_prefixes: pairs("timePrefixes")
            .into_iter()
            .map(|(p, b)| (p, b == Value::Bool(true)))
            .collect(),
        time_suffixes: list("timeSuffixes"),
        hour_letter: v["hourLetter"].as_str().map(str::to_owned),
        noon: list("noon"),
        midnight: list("midnight"),
    }
}

static LEXICONS: LazyLock<Vec<(String, Lexicon)>> = LazyLock::new(|| {
    let doc: Value =
        serde_json::from_str(include_str!("quick_add_lexicons.json")).expect("lexicons");
    doc.as_object()
        .expect("an object of languages")
        .iter()
        .map(|(code, lex)| (code.clone(), parse_lexicon(lex)))
        .collect()
});

fn lexicon(code: &str) -> Option<&'static Lexicon> {
    LEXICONS.iter().find(|(c, _)| c == code).map(|(_, l)| l)
}

/// The lexicons to match for a UI language: its own, then English (`quickAddLexicons`).
pub fn quick_add_lexicons(language: Option<&str>) -> Vec<&'static Lexicon> {
    let lower = language.unwrap_or("").to_lowercase();
    let base = lower.split(['-', '_']).next().unwrap_or("");
    let en = lexicon("en").expect("English lexicon");
    match lexicon(base) {
        Some(own) if base != "en" => vec![own, en],
        _ => vec![en],
    }
}

/// Lowercase, strip accents, unify apostrophes (`fold`).
pub fn fold(s: &str) -> String {
    s.to_lowercase()
        .nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .replace('ł', "l")
        .replace('ß', "ss")
        .replace(['’', '‘', '`'], "'")
}

fn bare(word: &str) -> &str {
    word.trim_end_matches(['.', ','])
}

fn phrase_at(words: &[String], i: usize, phrase: &str) -> usize {
    let parts: Vec<&str> = phrase.split(' ').collect();
    for (k, part) in parts.iter().enumerate() {
        let Some(w) = words.get(i + k) else {
            return 0;
        };
        if w != part && bare(w) != *part {
            return 0;
        }
    }
    parts.len()
}

fn any_at(words: &[String], i: usize, phrases: &[String]) -> usize {
    phrases
        .iter()
        .map(|p| phrase_at(words, i, p))
        .max()
        .unwrap_or(0)
}

fn key_at<T: Copy>(words: &[String], i: usize, map: &[(String, T)]) -> Option<(T, usize)> {
    let mut found: Option<(T, usize)> = None;
    for (phrase, value) in map {
        let n = phrase_at(words, i, phrase);
        if n > found.map_or(0, |f| f.1) {
            found = Some((*value, n));
        }
    }
    found
}

/// Leading ASCII digits of `s` (at most `max`), and the rest.
fn split_digits(s: &str, max: usize) -> Option<(&str, &str)> {
    let n = s.bytes().take_while(u8::is_ascii_digit).count();
    (n >= 1 && n <= max).then(|| s.split_at(n))
}

fn number(d: &str) -> i64 {
    d.parse().unwrap_or(i64::MAX)
}

fn count_at(words: &[String], i: usize, lex: &Lexicon) -> Option<i64> {
    let w = words.get(i)?;
    if let Some((d, rest)) = split_digits(w, usize::MAX) {
        if rest.is_empty() || rest == "." {
            return Some(number(d));
        }
    }
    lex.one.contains(w).then_some(1)
}

fn day_number_at(words: &[String], i: usize) -> Option<i64> {
    let (d, mut rest) = split_digits(words.get(i)?, 2)?;
    rest = rest.strip_suffix(',').unwrap_or(rest);
    loop {
        if rest.is_empty() {
            return Some(number(d));
        }
        let next = ["st", "nd", "rd", "th", "er", "º", "ª", "°", "."]
            .iter()
            .find_map(|s| rest.strip_prefix(s));
        rest = next?;
    }
}

fn rule(freq: Freq, interval: i64, byday: Vec<i64>, mode: RecurMode) -> Rule {
    Rule {
        freq,
        interval,
        byday,
        bymonthday: None,
        mode,
        at: None,
    }
}

fn match_recurrence(words: &[String], i: usize, lex: &Lexicon) -> Option<(String, usize)> {
    let head = &words[i];
    let after_completion = head.ends_with('!') && head.encode_utf16().count() > 1;
    let mut view = words.to_vec();
    if after_completion {
        view[i] = head[..head.len() - 1].to_owned();
    }
    let mode = if after_completion {
        RecurMode::AfterCompletion
    } else {
        RecurMode::OnSchedule
    };
    let single = if after_completion {
        None
    } else {
        key_at(&view, i, &lex.single)
    };
    let (mut r, mut consumed) = if let Some((freq, n)) = single {
        (rule(freq, 1, vec![], mode), n)
    } else {
        let every = any_at(&view, i, &lex.every);
        if every == 0 {
            return None;
        }
        let j = i + every;
        if let Some((wd, n)) = key_at(&view, j, &lex.weekdays) {
            (rule(Freq::Weekly, 1, vec![(wd + 6) % 7], mode), every + n)
        } else if let Some((freq, n)) = key_at(&view, j, &lex.units) {
            (rule(freq, 1, vec![], mode), every + n)
        } else {
            let count = count_at(&view, j, lex)?;
            let (freq, n) = key_at(&view, j + 1, &lex.units)?;
            (rule(freq, count.max(1), vec![], mode), every + 1 + n)
        }
    };
    let from = any_at(&view, i + consumed, &lex.from_completion);
    if from > 0 {
        r.mode = RecurMode::AfterCompletion;
        consumed += from;
    }
    Some((rule_to_string(&r), consumed))
}

fn days_until_weekday(weekday: i64, now: i64, tz: &TimeZone) -> i64 {
    let today = zoned_parts(now, tz).map_or(0, |p| p.weekday);
    (weekday - today + 7) % 7
}

/// The UTC day of a `Date.UTC` instant.
fn utc_day_of_month(ms: i64) -> i64 {
    civil_from_days(ms.div_euclid(DAY_MS)).2
}

fn month_day_day(month: i64, day: i64, now: i64, tz: &TimeZone) -> Option<i64> {
    let today = start_of_day(now, tz);
    if day < 1 {
        return None;
    }
    let year = zoned_parts(now, tz)?.year;
    for y in [year, year + 1] {
        if day > utc_day_of_month(date_utc(y, month + 1, 0, 0, 0, 0)) {
            continue;
        }
        let dt = make_instant(y, month, day, 0, 0, 0, tz);
        if dt >= today {
            return Some(dt);
        }
    }
    None
}

fn add_months_zoned(day_start: i64, n: i64, tz: &TimeZone) -> i64 {
    let Some(p) = zoned_parts(day_start, tz) else {
        return day_start;
    };
    let target = p.month + n;
    let last = utc_day_of_month(date_utc(p.year, target + 1, 0, 0, 0, 0));
    make_instant(p.year, target, p.day.min(last), 0, 0, 0, tz)
}

fn match_date_core(
    words: &[String],
    i: usize,
    now: i64,
    tz: &TimeZone,
    lex: &Lexicon,
) -> Option<(i64, usize)> {
    let today = start_of_day(now, tz);
    let weekday_day = |wd: i64, next: bool| {
        let mut delta = days_until_weekday(wd, now, tz);
        if next && delta == 0 {
            delta = 7;
        }
        add_days(today, delta, tz)
    };
    let unit_day = |freq: Freq, n: i64| match freq {
        Freq::Daily => add_days(today, n, tz),
        Freq::Weekly => add_days(today, n * 7, tz),
        Freq::Monthly => add_months_zoned(today, n, tz),
        Freq::Yearly => add_months_zoned(today, n * 12, tz),
    };

    if let Some((n, c)) = key_at(words, i, &lex.relative_days) {
        return Some((add_days(today, n, tz), c));
    }

    let in_p = any_at(words, i, &lex.in_prefixes);
    if in_p > 0 {
        if let Some(n) = count_at(words, i + in_p, lex) {
            if let Some((freq, c)) = key_at(words, i + in_p + 1, &lex.units) {
                return Some((unit_day(freq, n), in_p + 1 + c));
            }
        }
        if lex.in_bare_unit {
            if let Some((freq, c)) = key_at(words, i + in_p, &lex.units) {
                return Some((unit_day(freq, 1), in_p + c));
            }
        }
    }

    let next_p = any_at(words, i, &lex.next_prefixes);
    let this_p = if next_p > 0 {
        0
    } else {
        any_at(words, i, &lex.this_prefixes)
    };
    if next_p > 0 || this_p > 0 {
        let j = i + next_p.max(this_p);
        if let Some((wd, c)) = key_at(words, j, &lex.weekdays) {
            return Some((weekday_day(wd, next_p > 0), j - i + c));
        }
        if let Some((freq, c)) = key_at(words, j, &lex.units) {
            if freq != Freq::Daily {
                return Some((unit_day(freq, 1), j - i + c));
            }
        }
    }

    if let Some((wd, c)) = key_at(words, i, &lex.weekdays) {
        let next = any_at(words, i + c, &lex.next_suffixes);
        return Some((weekday_day(wd, next > 0), c + next));
    }
    if let Some((freq, c)) = key_at(words, i, &lex.units) {
        if freq != Freq::Daily {
            let next = any_at(words, i + c, &lex.next_suffixes);
            if next > 0 {
                return Some((unit_day(freq, 1), c + next));
            }
        }
    }

    if lex.month_first {
        if let Some((mon, c)) = key_at(words, i, &lex.months) {
            if let Some(d) = day_number_at(words, i + c) {
                if let Some(dt) = month_day_day(mon, d, now, tz) {
                    return Some((dt, c + 1));
                }
            }
        }
    }

    if let Some(d) = day_number_at(words, i) {
        let conn = any_at(words, i + 1, &lex.month_connectors);
        let after_conn = key_at(words, i + 1 + conn, &lex.months);
        let mon = after_conn.or_else(|| {
            if conn > 0 {
                key_at(words, i + 1, &lex.months)
            } else {
                None
            }
        });
        if let Some((mon, c)) = mon {
            let used = if after_conn.is_some() { conn } else { 0 };
            if let Some(dt) = month_day_day(mon, d, now, tz) {
                return Some((dt, 1 + used + c));
            }
        }
    }
    None
}

fn match_date(
    words: &[String],
    i: usize,
    now: i64,
    tz: &TimeZone,
    lex: &Lexicon,
) -> Option<(i64, usize)> {
    let lead = any_at(words, i, &lex.lead_ins);
    if lead > 0 {
        if let Some((day, c)) = match_date_core(words, i + lead, now, tz, lex) {
            return Some((day, lead + c));
        }
    }
    match_date_core(words, i, now, tz, lex)
}

fn clock(h: &str, m: Option<&str>) -> Option<i64> {
    let hour = number(h);
    let min = m.map_or(0, number);
    (hour <= 23 && min <= 59).then_some(hour * 60 + min)
}

/// `^(\d{1,2})(?:[:.](\d{2}))?` then exactly `tail`.
fn hour_minutes<'a>(
    w: &'a str,
    tail: impl Fn(&'a str) -> bool,
) -> Option<(&'a str, Option<&'a str>)> {
    let (h, rest) = split_digits(w, 2)?;
    if tail(rest) {
        return Some((h, None));
    }
    let rest2 = rest.strip_prefix([':', '.'])?;
    let (m, rest3) = split_digits(rest2, 2)?;
    (m.len() == 2 && tail(rest3)).then_some((h, Some(m)))
}

fn numeric_time(word: &str) -> Option<i64> {
    for suffix in ["am", "pm"] {
        if let Some((h, m)) = hour_minutes(word, |r| r == suffix) {
            let mut hour = number(h);
            let min = m.map_or(0, number);
            if hour > 12 || min > 59 {
                return None;
            }
            if suffix == "pm" && hour != 12 {
                hour += 12;
            }
            if suffix == "am" && hour == 12 {
                hour = 0;
            }
            return Some(hour * 60 + min);
        }
    }
    match hour_minutes(word, str::is_empty)? {
        (h, Some(m)) => clock(h, Some(m)),
        _ => None,
    }
}

fn time_token_at(words: &[String], i: usize, lex: &Lexicon) -> Option<(i64, usize)> {
    let w = words.get(i)?;
    let suffix = |j: usize| any_at(words, j, &lex.time_suffixes);
    if let Some(t) = numeric_time(bare(w)).or_else(|| numeric_time(w)) {
        return Some((t, 1 + suffix(i + 1)));
    }
    if let Some(letter) = &lex.hour_letter {
        let b = bare(w);
        if let Some((h, rest)) = split_digits(b, 2) {
            if let Some(after) = rest.strip_prefix(letter.as_str()) {
                let m = match split_digits(after, 2) {
                    Some((m, "")) if m.len() == 2 => Some(Some(m)),
                    None if after.is_empty() => Some(None),
                    _ => None,
                };
                if let Some(m) = m {
                    if let Some(t) = clock(h, m) {
                        return Some((t, 1));
                    }
                }
            }
        }
    }
    if let Some((h, "")) = split_digits(w, 2) {
        if suffix(i + 1) > 0 {
            if let Some(t) = clock(h, None) {
                return Some((t, 1 + suffix(i + 1)));
            }
        }
    }
    None
}

fn match_time(words: &[String], i: usize, lex: &Lexicon) -> Option<(i64, usize)> {
    let noon = any_at(words, i, &lex.noon);
    if noon > 0 {
        return Some((12 * 60, noon));
    }
    let midnight = any_at(words, i, &lex.midnight);
    if midnight > 0 {
        return Some((0, midnight));
    }
    let both: Vec<String> = lex.noon.iter().chain(&lex.midnight).cloned().collect();
    for (prefix, bare_hour) in &lex.time_prefixes {
        let p = phrase_at(words, i, prefix);
        if p == 0 {
            continue;
        }
        let j = i + p;
        let word = any_at(words, j, &both);
        if word > 0 {
            let t = if any_at(words, j, &lex.noon) > 0 {
                12 * 60
            } else {
                0
            };
            return Some((t, p + word));
        }
        if let Some((t, c)) = time_token_at(words, j, lex) {
            return Some((t, p + c));
        }
        if *bare_hour {
            if let Some((h, "")) = words.get(j).and_then(|w| split_digits(w, 2)) {
                if let Some(t) = clock(h, None) {
                    return Some((t, p + 1));
                }
            }
        }
    }
    for prefix in &lex.glued_time_prefixes {
        let w = &words[i];
        let Some(rest) = w.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if let Some((h, m)) = hour_minutes(rest, str::is_empty) {
            if let Some(t) = clock(h, m) {
                return Some((t, 1));
            }
        }
    }
    time_token_at(words, i, lex)
}

fn first_of<T>(lexicons: &[&Lexicon], f: impl Fn(&Lexicon) -> Option<T>) -> Option<T> {
    lexicons.iter().find_map(|l| f(l))
}

fn first_rule_day(rule: &str, now: i64, tz: &TimeZone) -> i64 {
    let today = start_of_day(now, tz);
    match parse_rule(rule) {
        Some(p) if p.freq == Freq::Weekly && !p.byday.is_empty() => {
            let today_mon0 = (zoned_parts(now, tz).map_or(0, |p| p.weekday) + 6) % 7;
            let delta = p
                .byday
                .iter()
                .map(|d| (d - today_mon0 + 7) % 7)
                .min()
                .unwrap_or(0);
            add_days(today, delta, tz)
        }
        _ => today,
    }
}

fn at_minutes(day_ms: i64, minutes: i64, tz: &TimeZone) -> i64 {
    match zoned_parts(day_ms, tz) {
        Some(p) => make_instant(p.year, p.month, p.day, minutes / 60, minutes % 60, 0, tz),
        None => day_ms,
    }
}

/// A project's id by its name, when there is one.
pub type ProjectLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// What quick add is parsed against.
#[derive(Default)]
pub struct QuickAddContext<'a> {
    /// Resolve `#name`; without it every `#name` is taken (and not resolved).
    pub project_id_by_name: Option<ProjectLookup<'a>>,
    /// Whether `@name` is a label; without it every `@name` is.
    pub is_known_label: Option<&'a dyn Fn(&str) -> bool>,
    pub language: Option<&'a str>,
    /// Phrases (lowercase) the user unlinked: kept as title text.
    pub ignore_dates: Vec<String>,
    pub ignore_projects: Vec<String>,
    pub ignore_labels: Vec<String>,
    pub disable_dates: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DateMatchSpan {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct QuickAddResult {
    pub title: String,
    pub priority: Option<u8>,
    pub due_at: Option<i64>,
    pub recurrence: Option<String>,
    pub project_id: Option<String>,
    pub labels: Vec<String>,
    pub date_match: Option<DateMatchSpan>,
}

struct Matched {
    start_word: usize,
    consumed: usize,
    value: i64,
    phrase: String,
    span: (usize, usize),
}

pub fn parse_quick_add(
    text: &str,
    now: i64,
    tz: &TimeZone,
    ctx: &QuickAddContext<'_>,
) -> QuickAddResult {
    let lexicons = quick_add_lexicons(ctx.language);
    // Words (`\S+`) with their UTF-16 start offsets.
    let mut words: Vec<String> = Vec::new();
    let mut starts: Vec<usize> = Vec::new();
    let mut at = 0;
    let mut current: Option<(usize, String)> = None;
    for ch in text.chars() {
        if js_space(ch) {
            if let Some((s, w)) = current.take() {
                starts.push(s);
                words.push(w);
            }
        } else {
            current
                .get_or_insert_with(|| (at, String::new()))
                .1
                .push(ch);
        }
        at += ch.len_utf16();
    }
    if let Some((s, w)) = current {
        starts.push(s);
        words.push(w);
    }
    let utf16_len = |w: &str| w.encode_utf16().count();
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    let folded: Vec<String> = words.iter().map(|w| fold(w)).collect();

    let mut priority = None;
    let mut project_name: Option<String> = None;
    let mut resolved_project = None;
    let mut labels = Vec::new();
    let mut recurrence: Option<String> = None;
    let mut matched_date: Option<Matched> = None;
    let mut matched_time: Option<Matched> = None;
    let mut consumed_words = BTreeSet::new();

    let unlinked = |list: &[String], w: &str, name: &str| {
        [
            w.to_lowercase(),
            name.to_lowercase(),
            w.to_owned(),
            name.to_owned(),
        ]
        .iter()
        .any(|x| list.contains(x))
    };

    let mut i = 0;
    while i < words.len() {
        let w = &words[i];
        let lw = &lower[i];
        let lb = lw.as_bytes();
        if lb.len() == 2 && lb[0] == b'p' && (b'1'..=b'4').contains(&lb[1]) {
            priority = Some(lb[1] - b'0');
            consumed_words.insert(i);
            i += 1;
            continue;
        }
        if let Some(name) = w.strip_prefix('#').filter(|n| !n.is_empty()) {
            if !unlinked(&ctx.ignore_projects, w, name) {
                let resolved = ctx.project_id_by_name.and_then(|f| f(name));
                if ctx.project_id_by_name.is_none() || resolved.is_some() {
                    project_name = Some(name.to_owned());
                    consumed_words.insert(i);
                    if resolved.is_some() {
                        resolved_project = resolved;
                    }
                }
            }
            i += 1;
            continue;
        }
        if let Some(name) = w.strip_prefix('@').filter(|n| !n.is_empty()) {
            if !unlinked(&ctx.ignore_labels, w, name) && ctx.is_known_label.is_none_or(|f| f(name))
            {
                labels.push(name.to_owned());
                consumed_words.insert(i);
            }
            i += 1;
            continue;
        }
        if let Some((rule, c)) = first_of(&lexicons, |lex| match_recurrence(&folded, i, lex)) {
            recurrence = Some(rule);
            consumed_words.extend(i..i + c);
            i += c;
            continue;
        }
        let span_of = |c: usize| {
            let last = i + c - 1;
            (starts[i], starts[last] + utf16_len(&words[last]))
        };
        let date = if ctx.disable_dates {
            None
        } else {
            first_of(&lexicons, |lex| match_date(&folded, i, now, tz, lex))
        };
        if let (Some((day, c)), None) = (date, &matched_date) {
            matched_date = Some(Matched {
                start_word: i,
                consumed: c,
                value: day,
                phrase: lower[i..i + c].join(" "),
                span: span_of(c),
            });
            i += c;
            continue;
        }
        let time = if ctx.disable_dates {
            None
        } else {
            first_of(&lexicons, |lex| match_time(&folded, i, lex))
        };
        if let (Some((t, c)), None) = (time, &matched_time) {
            matched_time = Some(Matched {
                start_word: i,
                consumed: c,
                value: t,
                phrase: lower[i..i + c].join(" "),
                span: span_of(c),
            });
            i += c;
            continue;
        }
        i += 1;
    }

    let mut due_day = None;
    let mut due_time = None;
    let mut date_match = None;
    let ignored = |p: &str| ctx.ignore_dates.iter().any(|x| x == p);
    let utf16: Vec<u16> = text.encode_utf16().collect();
    match (&matched_date, &matched_time) {
        (Some(d), Some(t)) => {
            let adjacent = d.start_word + d.consumed == t.start_word
                || t.start_word + t.consumed == d.start_word;
            if adjacent {
                let start = d.span.0.min(t.span.0);
                let end = d.span.1.max(t.span.1);
                let phrase = String::from_utf16_lossy(&utf16[start..end])
                    .to_lowercase()
                    .trim()
                    .to_owned();
                if !(ignored(&phrase) || ignored(&d.phrase) || ignored(&t.phrase)) {
                    due_day = Some(d.value);
                    due_time = Some(t.value);
                    date_match = Some(DateMatchSpan {
                        start,
                        end,
                        text: phrase,
                    });
                    consumed_words.extend(d.start_word..d.start_word + d.consumed);
                    consumed_words.extend(t.start_word..t.start_word + t.consumed);
                }
            } else {
                let date_unlinked = ignored(&d.phrase);
                let time_unlinked = ignored(&t.phrase);
                if !date_unlinked {
                    due_day = Some(d.value);
                    consumed_words.extend(d.start_word..d.start_word + d.consumed);
                }
                if !time_unlinked {
                    due_time = Some(t.value);
                    consumed_words.extend(t.start_word..t.start_word + t.consumed);
                }
                let shown = if !date_unlinked {
                    Some(d)
                } else if !time_unlinked {
                    Some(t)
                } else {
                    None
                };
                date_match = shown.map(|m| DateMatchSpan {
                    start: m.span.0,
                    end: m.span.1,
                    text: m.phrase.clone(),
                });
            }
        }
        (Some(m), None) | (None, Some(m)) => {
            if !ignored(&m.phrase) {
                if matched_date.is_some() {
                    due_day = Some(m.value);
                } else {
                    due_time = Some(m.value);
                }
                date_match = Some(DateMatchSpan {
                    start: m.span.0,
                    end: m.span.1,
                    text: m.phrase.clone(),
                });
                consumed_words.extend(m.start_word..m.start_word + m.consumed);
            }
        }
        (None, None) => {}
    }

    let title_words: Vec<&str> = words
        .iter()
        .enumerate()
        .filter(|(i, _)| !consumed_words.contains(i))
        .map(|(_, w)| w.as_str())
        .collect();
    let day = due_day.or_else(|| recurrence.as_deref().map(|r| first_rule_day(r, now, tz)));
    let due_at = match (day, due_time) {
        (Some(day), Some(t)) => Some(at_minutes(day, t, tz)),
        (Some(day), None) => Some(end_of_day(day, tz)),
        (None, Some(t)) => Some(at_minutes(now, t, tz)),
        (None, None) => None,
    };
    if let (Some(r), Some(due)) = (&recurrence, due_at) {
        recurrence = Some(anchor_month_day(r, due, tz));
    }
    let _ = project_name;
    QuickAddResult {
        title: title_words.join(" ").trim_matches(js_space).to_owned(),
        priority,
        due_at,
        recurrence: recurrence.filter(|r| !r.is_empty()),
        project_id: resolved_project,
        labels,
        date_match,
    }
}
