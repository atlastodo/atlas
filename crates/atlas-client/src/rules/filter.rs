//! The filter query language of saved filters (`filterQuery.ts`): `@work & due:week & p1`,
//! `#home | (p1 & !due:none)`. NOT binds tightest, then AND (also by adjacency), then OR.
//! Error positions count UTF-16 code units, as in JavaScript.

use jiff::tz::TimeZone;

use super::task::{ms, Task};
use super::zoned::{day_offset, zoned_parts};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueWhen {
    Today,
    Tomorrow,
    Week,
    Month,
    Weekend,
    NextWeek,
    Overdue,
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FilterNode {
    And(Box<FilterNode>, Box<FilterNode>),
    Or(Box<FilterNode>, Box<FilterNode>),
    Not(Box<FilterNode>),
    Priority(u8),
    Label(String),
    Project(String),
    Due(DueWhen),
    DueWithin(f64),
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FilterError {
    pub error: String,
    pub at: usize,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    And,
    Or,
    Not,
    LParen,
    RParen,
    Atom(String),
}

impl Tok {
    fn kind(&self) -> &'static str {
        match self {
            Tok::And => "and",
            Tok::Or => "or",
            Tok::Not => "not",
            Tok::LParen => "lparen",
            Tok::RParen => "rparen",
            Tok::Atom(_) => "atom",
        }
    }
}

/// JavaScript's `\s`.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn tokenize(input: &str) -> Vec<(Tok, usize)> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut word_at = 0;
    let flush = |word: &mut String, word_at: usize, tokens: &mut Vec<(Tok, usize)>| {
        if word.is_empty() {
            return;
        }
        let tok = match word.to_lowercase().as_str() {
            "and" => Tok::And,
            "or" => Tok::Or,
            "not" => Tok::Not,
            _ => Tok::Atom(word.clone()),
        };
        tokens.push((tok, word_at));
        word.clear();
    };
    let mut at = 0; // UTF-16 index
    for ch in input.chars() {
        let sym = match ch {
            '&' => Some(Tok::And),
            '|' => Some(Tok::Or),
            '!' => Some(Tok::Not),
            '(' => Some(Tok::LParen),
            ')' => Some(Tok::RParen),
            _ => None,
        };
        if js_space(ch) {
            flush(&mut word, word_at, &mut tokens);
        } else if let Some(t) = sym {
            flush(&mut word, word_at, &mut tokens);
            tokens.push((t, at));
        } else {
            if word.is_empty() {
                word_at = at;
            }
            word.push(ch);
        }
        at += ch.len_utf16();
    }
    flush(&mut word, word_at, &mut tokens);
    tokens
}

const DUE_VALUES: [&str; 8] = [
    "today",
    "tomorrow",
    "week",
    "month",
    "weekend",
    "next-week",
    "overdue",
    "none",
];

fn due_when(s: &str) -> Option<DueWhen> {
    Some(match s {
        "today" => DueWhen::Today,
        "tomorrow" => DueWhen::Tomorrow,
        "week" | "this-week" => DueWhen::Week,
        "month" | "this-month" => DueWhen::Month,
        "weekend" => DueWhen::Weekend,
        "next-week" | "nextweek" => DueWhen::NextWeek,
        "overdue" => DueWhen::Overdue,
        "none" => DueWhen::None,
        _ => return None,
    })
}

fn atom_to_node(value: &str, at: usize) -> Result<FilterNode, FilterError> {
    let err = |error: String| FilterError { error, at };
    let lower = value.to_lowercase();
    let b = value.as_bytes();
    if b.len() == 2 && (b[0] == b'p' || b[0] == b'P') && (b'1'..=b'4').contains(&b[1]) {
        return Ok(FilterNode::Priority(b[1] - b'0'));
    }
    if value == "overdue" {
        return Ok(FilterNode::Due(DueWhen::Overdue));
    }
    if let Some(name) = value.strip_prefix('@') {
        if name.is_empty() {
            return Err(err("expected a label name after '@'".into()));
        }
        return Ok(FilterNode::Label(name.to_owned()));
    }
    if let Some(name) = value.strip_prefix('#') {
        if name.is_empty() {
            return Err(err("expected a project name after '#'".into()));
        }
        return Ok(FilterNode::Project(name.to_owned()));
    }
    if lower.starts_with("due:") {
        // `value.slice(4).toLowerCase()`: the four characters "due:" are ASCII either way.
        let raw = value.chars().skip(4).collect::<String>().to_lowercase();
        if let Some(n) = raw
            .strip_suffix('d')
            .filter(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        {
            return Ok(FilterNode::DueWithin(
                n.parse::<f64>().unwrap_or(f64::INFINITY),
            ));
        }
        return match due_when(&raw) {
            Some(w) => Ok(FilterNode::Due(w)),
            None => Err(err(format!(
                "unknown due value '{raw}' (expected {}, or Nd e.g. 7d)",
                DUE_VALUES.join(", ")
            ))),
        };
    }
    Ok(FilterNode::Text(value.to_owned()))
}

struct Parser<'a> {
    tokens: Vec<(Tok, usize)>,
    pos: usize,
    len: usize,
    _input: &'a str,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos).map(|(t, _)| t)
    }

    fn next_index(&self) -> usize {
        self.tokens.get(self.pos).map_or(self.len, |(_, at)| *at)
    }

    fn or(&mut self) -> Result<FilterNode, FilterError> {
        let mut left = self.and()?;
        while self.peek() == Some(&Tok::Or) {
            self.pos += 1;
            left = FilterNode::Or(Box::new(left), Box::new(self.and()?));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<FilterNode, FilterError> {
        let mut left = self.not()?;
        loop {
            match self.peek() {
                Some(Tok::And) => {
                    self.pos += 1;
                    left = FilterNode::And(Box::new(left), Box::new(self.not()?));
                }
                Some(Tok::Atom(_) | Tok::LParen | Tok::Not) => {
                    left = FilterNode::And(Box::new(left), Box::new(self.not()?));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn not(&mut self) -> Result<FilterNode, FilterError> {
        if self.peek() == Some(&Tok::Not) {
            self.pos += 1;
            return Ok(FilterNode::Not(Box::new(self.not()?)));
        }
        self.term()
    }

    fn term(&mut self) -> Result<FilterNode, FilterError> {
        let Some((tok, at)) = self.tokens.get(self.pos).cloned() else {
            return Err(FilterError {
                error: "unexpected end of query".into(),
                at: self.len,
            });
        };
        match tok {
            Tok::LParen => {
                self.pos += 1;
                let inner = self.or()?;
                if self.peek() != Some(&Tok::RParen) {
                    return Err(FilterError {
                        error: "expected ')'".into(),
                        at: self.next_index(),
                    });
                }
                self.pos += 1;
                Ok(inner)
            }
            Tok::Atom(value) => {
                self.pos += 1;
                atom_to_node(&value, at)
            }
            other => Err(FilterError {
                error: format!("unexpected '{}'", other.kind()),
                at,
            }),
        }
    }
}

pub fn parse(input: &str) -> Result<FilterNode, FilterError> {
    let tokens = tokenize(input);
    if tokens.is_empty() {
        return Err(FilterError {
            error: "empty query".into(),
            at: 0,
        });
    }
    let mut p = Parser {
        tokens,
        pos: 0,
        len: input.encode_utf16().count(),
        _input: input,
    };
    let ast = p.or()?;
    if p.pos < p.tokens.len() {
        return Err(FilterError {
            error: "unexpected trailing input".into(),
            at: p.next_index(),
        });
    }
    Ok(ast)
}

/// What a filter is evaluated against besides the task.
pub struct EvalContext<'a> {
    pub now: i64,
    pub tz: &'a TimeZone,
    pub labels_of: &'a dyn Fn(&Task) -> Vec<String>,
    pub project_name_of: &'a dyn Fn(&Task) -> Option<String>,
    /// Sunday = 0; Monday by default.
    pub week_starts_on: i64,
}

pub fn is_overdue(task: &Task, now: i64) -> bool {
    !task.is_completed && task.due_ms().is_some_and(|d| d < now)
}

fn matches_due(task: &Task, when: DueWhen, cx: &EvalContext<'_>) -> bool {
    let tz = cx.tz;
    let now = cx.now;
    if when == DueWhen::None {
        return task.due_at.is_none();
    }
    if when == DueWhen::Overdue {
        return is_overdue(task, now);
    }
    let Some(due) = task.due_at.as_ref().map(ms) else {
        return false;
    };
    let weekday = |t: i64| zoned_parts(t, tz).map_or(0, |p| p.weekday);
    match when {
        DueWhen::Month => match (zoned_parts(due, tz), zoned_parts(now, tz)) {
            (Some(d), Some(n)) => d.year == n.year && d.month == n.month,
            _ => false,
        },
        DueWhen::Weekend => {
            let off = day_offset(due, now, tz);
            let sunday = (7 - weekday(now)) % 7;
            off >= (sunday - 1).max(0) && off <= sunday
        }
        DueWhen::NextWeek => {
            let off = day_offset(due, now, tz);
            let start_day = cx.week_starts_on.rem_euclid(7);
            let start = 7 - (weekday(now) - start_day + 7) % 7;
            off >= start && off <= start + 6
        }
        DueWhen::Today => day_offset(due, now, tz) == 0,
        DueWhen::Tomorrow => day_offset(due, now, tz) == 1,
        _ => {
            let off = day_offset(due, now, tz);
            (0..=7).contains(&off)
        }
    }
}

pub fn evaluate(node: &FilterNode, task: &Task, cx: &EvalContext<'_>) -> bool {
    match node {
        FilterNode::And(l, r) => evaluate(l, task, cx) && evaluate(r, task, cx),
        FilterNode::Or(l, r) => evaluate(l, task, cx) || evaluate(r, task, cx),
        FilterNode::Not(c) => !evaluate(c, task, cx),
        FilterNode::Priority(p) => task.priority == *p,
        FilterNode::Text(v) => task.title.to_lowercase().contains(&v.to_lowercase()),
        FilterNode::Due(w) => matches_due(task, *w, cx),
        FilterNode::DueWithin(days) => match task.due_at.as_ref().map(ms) {
            Some(due) => {
                let off = day_offset(due, cx.now, cx.tz);
                off >= 0 && (off as f64) < *days
            }
            None => false,
        },
        FilterNode::Label(name) => {
            let name = name.to_lowercase();
            (cx.labels_of)(task)
                .iter()
                .any(|n| n.to_lowercase() == name)
        }
        FilterNode::Project(name) => {
            (cx.project_name_of)(task).is_some_and(|n| n.to_lowercase() == name.to_lowercase())
        }
    }
}
