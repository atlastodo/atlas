import { describe, it, expect } from "vitest";
import { parseQuickAdd } from "./quickAddParse";

// Mon 2 Jan 2023, 10:00 local. Using local Date components keeps the test timezone-independent:
// the parser and these expectations both use the local calendar.
const NOW = new Date(2023, 0, 2, 10, 0, 0).getTime();
// Date-only dues are all-day: the default time is 23:59.
const day = (y: number, m: number, d: number, h = 23, min = 59) =>
  new Date(y, m, d, h, min, 0, 0).getTime();

describe("parseQuickAdd — dates & times", () => {
  it("parses 'tomorrow'", () => {
    const r = parseQuickAdd("Buy milk tomorrow", NOW);
    expect(r.title).toBe("Buy milk");
    expect(r.input.due_at).toBe(day(2023, 0, 3));
  });

  it("combines a date and a time", () => {
    const r = parseQuickAdd("Buy milk tomorrow 5pm", NOW);
    expect(r.title).toBe("Buy milk");
    expect(r.input.due_at).toBe(day(2023, 0, 3, 17, 0));
  });

  it("parses 'today' and a 24h time", () => {
    expect(parseQuickAdd("Standup 09:30 today", NOW).input.due_at).toBe(day(2023, 0, 2, 9, 30));
  });

  it("parses relative 'in N days'", () => {
    expect(parseQuickAdd("Ping in 3 days", NOW).input.due_at).toBe(day(2023, 0, 5));
  });

  it("resolves 'today' to end of day (23:59) of the chosen timezone", () => {
    // 2026-07-15 12:00 UTC. A date without an explicit time is an all-day task: 23:59 in that zone.
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const utc = parseQuickAdd("Plan today", now, { timeZone: "UTC" });
    expect(utc.input.due_at).toBe(Date.UTC(2026, 6, 15, 23, 59, 0)); // 2026-07-15 23:59 UTC
    const ny = parseQuickAdd("Plan today", now, { timeZone: "America/New_York" });
    expect(ny.input.due_at).toBe(Date.UTC(2026, 6, 16, 3, 59, 0)); // 2026-07-15 23:59 EDT = 03:59 UTC next day
  });

  it("renders a date-only due chip when no time is typed", () => {
    const r = parseQuickAdd("Plan today", NOW);
    const chip = r.chips.find((c) => c.kind === "due");
    expect(chip).toBeDefined();
    expect(chip!.label).not.toMatch(/\d[:.]\d/); // all-day dues show the date only
  });

  it("includes the time in the due chip when one is typed", () => {
    const r = parseQuickAdd("Plan today 5pm", NOW);
    expect(r.chips.find((c) => c.kind === "due")!.label).toMatch(/\d[:.]\d/);
  });

  it("parses 'next monday' as a week out from today's monday", () => {
    expect(parseQuickAdd("Review next monday", NOW).input.due_at).toBe(day(2023, 0, 9));
  });

  it("parses a bare weekday as the next occurrence", () => {
    expect(parseQuickAdd("Submit friday", NOW).input.due_at).toBe(day(2023, 0, 6));
  });

  it("parses an absolute month/day", () => {
    expect(parseQuickAdd("Trip jun 3", NOW).input.due_at).toBe(day(2023, 5, 3));
  });

  it("rolls a past month/day into next year", () => {
    // Jan 1 is already behind NOW (Jan 2) → next year.
    expect(parseQuickAdd("Party jan 1", NOW).input.due_at).toBe(day(2024, 0, 1));
  });

  it("assumes today when only a time is given", () => {
    expect(parseQuickAdd("Call 5pm", NOW).input.due_at).toBe(day(2023, 0, 2, 17, 0));
  });

  it("parses time before date: 'name 13:00 mon'", () => {
    const r = parseQuickAdd("Meeting 13:00 mon", NOW);
    expect(r.title).toBe("Meeting");
    expect(r.input.due_at).toBe(day(2023, 0, 2, 13, 0));
    expect(r.dateMatch).toEqual({ start: 8, end: 17, text: "13:00 mon" });
  });

  it("parses date before time: 'name mon 13:00'", () => {
    const r = parseQuickAdd("Meeting mon 13:00", NOW);
    expect(r.title).toBe("Meeting");
    expect(r.input.due_at).toBe(day(2023, 0, 2, 13, 0));
    expect(r.dateMatch).toEqual({ start: 8, end: 17, text: "mon 13:00" });
  });

  it("parses 'at' prefix in time before and after date", () => {
    const r1 = parseQuickAdd("Meeting at 13:00 mon", NOW);
    expect(r1.title).toBe("Meeting");
    expect(r1.input.due_at).toBe(day(2023, 0, 2, 13, 0));
    expect(r1.dateMatch).toEqual({ start: 8, end: 20, text: "at 13:00 mon" });

    const r2 = parseQuickAdd("Meeting mon at 13:00", NOW);
    expect(r2.title).toBe("Meeting");
    expect(r2.input.due_at).toBe(day(2023, 0, 2, 13, 0));
    expect(r2.dateMatch).toEqual({ start: 8, end: 20, text: "mon at 13:00" });
  });

  it("parses dot notation in 24h time", () => {
    const r = parseQuickAdd("Lunch 13.00 mon", NOW);
    expect(r.title).toBe("Lunch");
    expect(r.input.due_at).toBe(day(2023, 0, 2, 13, 0));
  });

  it("provides dateMatch span when only time is given", () => {
    const r = parseQuickAdd("Sync 13:00", NOW);
    expect(r.title).toBe("Sync");
    expect(r.input.due_at).toBe(day(2023, 0, 2, 13, 0));
    expect(r.dateMatch).toEqual({ start: 5, end: 10, text: "13:00" });
  });
});

describe("parseQuickAdd — tags, priority, project", () => {
  it("extracts priority, project and label, cleaning the title", () => {
    const r = parseQuickAdd("Buy milk #groceries @errand p1", NOW, {
      projectIdByName: (n) => (n === "groceries" ? "proj-1" : null),
      isKnownLabel: (n) => n === "errand",
    });
    expect(r.title).toBe("Buy milk");
    expect(r.input.priority).toBe(1);
    expect(r.input.project_id).toBe("proj-1");
    expect(r.projectMatch).toEqual({
      start: 9,
      end: 19,
      text: "#groceries",
      value: "groceries",
    });
    expect(r.labelMatches).toEqual([
      {
        start: 20,
        end: 27,
        text: "@errand",
        value: "errand",
      },
    ]);
    expect(r.chips.map((c) => c.label)).toEqual(
      expect.arrayContaining(["#groceries", "@errand", "P1"]),
    );
  });

  it("keeps unknown #project and unknown @label literal in title without chipping when validators provided", () => {
    const r = parseQuickAdd("Task #unknown @unknown", NOW, {
      projectIdByName: () => null,
      isKnownLabel: () => false,
    });
    expect(r.title).toBe("Task #unknown @unknown");
    expect(r.input.project_id).toBeUndefined();
    expect(r.projectMatch).toBeUndefined();
    expect(r.labels).toEqual([]);
    expect(r.labelMatches).toBeUndefined();
    expect(r.chips.some((c) => c.kind === "project")).toBe(false);
    expect(r.chips.some((c) => c.kind === "label")).toBe(false);
  });

  it("provides both dateMatch and projectMatch when both are typed", () => {
    const r = parseQuickAdd("Meeting mon #work", NOW, {
      projectIdByName: (n) => (n === "work" ? "proj-work" : null),
    });
    expect(r.dateMatch).toEqual({ start: 8, end: 11, text: "mon" });
    expect(r.projectMatch).toEqual({
      start: 12,
      end: 17,
      text: "#work",
      value: "work",
    });
  });

  it("unlinks #project when ignored, keeping it in the title without setting project_id", () => {
    const r = parseQuickAdd("Buy milk #work", NOW, {
      projectIdByName: (n) => (n === "work" ? "proj-work" : null),
      ignoreProjects: ["#work"],
    });
    expect(r.title).toBe("Buy milk #work");
    expect(r.input.project_id).toBeUndefined();
    expect(r.projectMatch).toBeUndefined();
    expect(r.chips.some((c) => c.kind === "project")).toBe(false);
  });

  it("unlinks @label when ignored, keeping it in the title without tagging", () => {
    const r = parseQuickAdd("Call mom @urgent @errand", NOW, {
      isKnownLabel: (n) => n === "urgent" || n === "errand",
      ignoreLabels: ["@urgent"],
    });
    expect(r.title).toBe("Call mom @urgent");
    expect(r.labels).toEqual(["errand"]);
    expect(r.labelMatches).toEqual([
      {
        start: 17,
        end: 24,
        text: "@errand",
        value: "errand",
      },
    ]);
    expect(r.chips.some((c) => c.label === "@urgent")).toBe(false);
    expect(r.chips.some((c) => c.label === "@errand")).toBe(true);
  });
});

describe("parseQuickAdd — recurrence", () => {
  it("parses 'every day'", () => {
    const r = parseQuickAdd("Water plants every day", NOW);
    expect(r.title).toBe("Water plants");
    expect(r.input.recurrence).toBe("FREQ=DAILY");
    expect(r.input.due_at).toBe(day(2023, 0, 2)); // starts today
  });

  it("parses 'every 2 weeks'", () => {
    expect(parseQuickAdd("Standup every 2 weeks", NOW).input.recurrence).toBe(
      "FREQ=WEEKLY;INTERVAL=2",
    );
  });

  it("parses 'every monday' as a weekly BYDAY rule", () => {
    expect(parseQuickAdd("Sync every monday", NOW).input.recurrence).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("parses 'every!' as after-completion", () => {
    expect(parseQuickAdd("Vacuum every! 3 days", NOW).input.recurrence).toBe(
      "FREQ=DAILY;INTERVAL=3;MODE=COMPLETION",
    );
  });

  it("parses a spelled-out 'from completion' suffix as after-completion", () => {
    expect(parseQuickAdd("Review every 2 weeks from completion", NOW).input.recurrence).toBe(
      "FREQ=WEEKLY;INTERVAL=2;MODE=COMPLETION",
    );
    expect(parseQuickAdd("Water plants every day from completion", NOW).title).toBe("Water plants");
    // A "from ..." tail that isn't the mode phrase stays out of the rule — and in the title.
    const r = parseQuickAdd("Report every 2 weeks from HQ", NOW);
    expect(r.input.recurrence).toBe("FREQ=WEEKLY;INTERVAL=2");
    expect(r.title).toBe("Report from HQ");
  });

  it("keeps an explicit date as the recurrence anchor", () => {
    const r = parseQuickAdd("Rent every month jun 3", NOW);
    // The rule keeps the date's day of month, so it survives a shorter month.
    expect(r.input.recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=3");
    expect(r.input.due_at).toBe(day(2023, 5, 3));
  });
});

describe("parseQuickAdd — graceful degradation", () => {
  it("keeps unrecognized input verbatim in the title", () => {
    const r = parseQuickAdd("read chapter 3", NOW);
    expect(r.title).toBe("read chapter 3");
    expect(r.input.due_at).toBeUndefined();
    expect(r.input.recurrence).toBeUndefined();
    expect(r.chips).toHaveLength(0);
  });

  it("handles an empty string", () => {
    const r = parseQuickAdd("   ", NOW);
    expect(r.title).toBe("");
    expect(r.chips).toHaveLength(0);
  });

  // The "device default" timezone preference is the empty string, which Intl
  // rejects with a RangeError. A date keyword produces a due chip that formats a date, so an
  // unguarded "" blew up the whole page. An empty timeZone must resolve to the device zone instead.
  it("does not throw when the timezone is empty and a date chip is produced", () => {
    expect(() => parseQuickAdd("Report today", NOW, { timeZone: "" })).not.toThrow();
    const r = parseQuickAdd("Report today", NOW, { timeZone: "" });
    expect(r.title).toBe("Report");
    expect(r.chips.some((c) => c.kind === "due")).toBe(true);
  });
});

describe("parseQuickAdd — date match span & unlinking", () => {
  it("reports the character span of a recognized date phrase", () => {
    const r = parseQuickAdd("call fri", NOW);
    expect(r.dateMatch).toEqual({ start: 5, end: 8, text: "fri" });
    expect(r.title).toBe("call");
    expect(r.input.due_at).toBeDefined();
  });

  it("spans a multi-word date phrase", () => {
    const r = parseQuickAdd("ship next monday", NOW);
    expect(r.dateMatch).toMatchObject({ start: 5, end: 16, text: "next monday" });
  });

  it("keeps an unlinked date phrase as literal title text with no due date", () => {
    const r = parseQuickAdd("call fri", NOW, { ignoreDates: ["fri"] });
    expect(r.title).toBe("call fri");
    expect(r.input.due_at).toBeUndefined();
    expect(r.dateMatch).toBeUndefined();
    expect(r.chips.some((c) => c.kind === "due")).toBe(false);
  });

  it("unlinks composite date+time phrase when ignored", () => {
    const r = parseQuickAdd("Meeting 13:00 mon", NOW, { ignoreDates: ["13:00 mon"] });
    expect(r.title).toBe("Meeting 13:00 mon");
    expect(r.input.due_at).toBeUndefined();
    expect(r.dateMatch).toBeUndefined();
    expect(r.chips.some((c) => c.kind === "due")).toBe(false);
  });
});

describe("parseQuickAdd — Danish language dates & recurrence", () => {
  const DA = { language: "da" };

  it("parses 'i morgen'", () => {
    const r = parseQuickAdd("Køb mælk i morgen", NOW, DA);
    expect(r.input.due_at).toBe(day(2023, 0, 3));
    expect(r.title).toBe("Køb mælk");
    expect(r.dateMatch).toEqual({ start: 9, end: 17, text: "i morgen" });
  });

  it("combines 'i dag' and 'kl 17'", () => {
    const r = parseQuickAdd("Møde i dag kl 17", NOW, DA);
    expect(r.input.due_at).toBe(day(2023, 0, 2, 17, 0));
    expect(r.title).toBe("Møde");
  });

  it("parses 'om 3 dage'", () => {
    const r = parseQuickAdd("Aflever rapport om 3 dage", NOW, DA);
    expect(r.input.due_at).toBe(day(2023, 0, 5));
    expect(r.title).toBe("Aflever rapport");
    expect(r.dateMatch).toEqual({ start: 16, end: 25, text: "om 3 dage" });
  });

  it("parses Danish weekdays like 'fredag'", () => {
    const r = parseQuickAdd("Frokost fredag", NOW, DA);
    expect(r.input.due_at).toBe(day(2023, 0, 6));
    expect(r.title).toBe("Frokost");
  });

  it("parses 'næste tirsdag'", () => {
    const r = parseQuickAdd("Gennemgå næste tirsdag", NOW, DA);
    expect(r.input.due_at).toBe(day(2023, 0, 3));
    expect(r.title).toBe("Gennemgå");
  });

  it("parses day-first dates like '15. marts'", () => {
    const r = parseQuickAdd("Fødselsdag 15. marts", NOW, DA);
    expect(r.input.due_at).toBe(day(2023, 2, 15));
    expect(r.title).toBe("Fødselsdag");
  });

  it("parses Danish recurrence 'hver mandag' and 'hver 2. uge'", () => {
    expect(parseQuickAdd("Møde hver mandag", NOW, DA).input.recurrence).toBe(
      "FREQ=WEEKLY;BYDAY=MO",
    );
    expect(parseQuickAdd("Rengøring hver 2. uge", NOW, DA).input.recurrence).toBe(
      "FREQ=WEEKLY;INTERVAL=2",
    );
    expect(parseQuickAdd("Vand planter dagligt", NOW, DA).input.recurrence).toBe("FREQ=DAILY");
    expect(parseQuickAdd("Støvsug hver! 3 dage", NOW, DA).input.recurrence).toBe(
      "FREQ=DAILY;INTERVAL=3;MODE=COMPLETION",
    );
    expect(parseQuickAdd("Støvsug hver 3. uge fra fuldførelse", NOW, DA).input.recurrence).toBe(
      "FREQ=WEEKLY;INTERVAL=3;MODE=COMPLETION",
    );
  });

  it("unlinks multi-word Danish dates like 'i morgen'", () => {
    const r = parseQuickAdd("Køb mælk i morgen", NOW, { ...DA, ignoreDates: ["i morgen"] });
    expect(r.title).toBe("Køb mælk i morgen");
    expect(r.input.due_at).toBeUndefined();
    expect(r.dateMatch).toBeUndefined();
  });

  it("parses 'oct 9.' with trailing period", () => {
    const r = parseQuickAdd("Party oct 9.", NOW);
    expect(r.input.due_at).toBe(day(2023, 9, 9));
    expect(r.title).toBe("Party");
    expect(r.dateMatch?.text).toBe("oct 9.");
  });

  it("parses Danish '9. okt' and '9. okt.'", () => {
    const r1 = parseQuickAdd("Frokost 9. okt", NOW, DA);
    expect(r1.input.due_at).toBe(day(2023, 9, 9));
    expect(r1.title).toBe("Frokost");

    const r2 = parseQuickAdd("Frokost 9. okt.", NOW, DA);
    expect(r2.input.due_at).toBe(day(2023, 9, 9));
    expect(r2.title).toBe("Frokost");
  });

  it("parses 'sept 15' and '15. sept'", () => {
    const r1 = parseQuickAdd("Review sept 15", NOW);
    expect(r1.input.due_at).toBe(day(2023, 8, 15));
    expect(r1.title).toBe("Review");

    const r2 = parseQuickAdd("Review 15. sept", NOW);
    expect(r2.input.due_at).toBe(day(2023, 8, 15));
    expect(r2.title).toBe("Review");
  });

  it("formats due chip in the active language", () => {
    const en = parseQuickAdd("Party oct 9", NOW, { language: "en", timeZone: "UTC" });
    expect(en.chips.find((c) => c.kind === "due")?.label).toMatch(/Oct 9/);

    const da = parseQuickAdd("Party oct 9", NOW, { language: "da", timeZone: "UTC" });
    expect(da.chips.find((c) => c.kind === "due")?.label).toMatch(/9\. okt/);
  });
});

describe("parseQuickAdd — explicit times on DST days", () => {
  const CPH = "Europe/Copenhagen";
  const ctx = { timeZone: CPH, language: "en" };

  it("puts 'tomorrow 9am' at 09:00 local on a spring-forward day", () => {
    const now = 1_774_695_600_000; // Sat 2026-03-28 12:00 CET
    const r = parseQuickAdd("Call tomorrow 9am", now, ctx);
    expect(r.input.due_at).toBe(1_774_767_600_000); // Sun 2026-03-29 09:00 CEST
    expect(r.chips.find((c) => c.kind === "due")!.label).toMatch(/9:00/);
  });

  it("puts 'tomorrow 9am' at 09:00 local on a fall-back day", () => {
    const now = 1_792_836_000_000; // Sat 2026-10-24 12:00 CEST
    const r = parseQuickAdd("Call tomorrow 9am", now, ctx);
    expect(r.input.due_at).toBe(1_792_915_200_000); // Sun 2026-10-25 09:00 CET
    expect(r.chips.find((c) => c.kind === "due")!.label).toMatch(/9:00/);
  });

  it("puts a bare time on the DST day itself at that local time", () => {
    const now = 1_774_749_600_000; // Sun 2026-03-29 04:00 CEST
    expect(parseQuickAdd("Call 9am", now, ctx).input.due_at).toBe(1_774_767_600_000);
  });
});

describe("parseQuickAdd — first due date of a weekday rule", () => {
  const UTC = { timeZone: "UTC" };
  const WED = Date.UTC(2023, 0, 4, 10, 0, 0); // Wed 2023-01-04 10:00

  it("'every monday' without a date is first due on the next Monday", () => {
    const r = parseQuickAdd("Sync every monday", WED, UTC);
    expect(r.input.recurrence).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(r.input.due_at).toBe(Date.UTC(2023, 0, 9, 23, 59, 0));
  });

  it("counts today when it is the rule's weekday", () => {
    expect(parseQuickAdd("Sync every wednesday", WED, UTC).input.due_at).toBe(
      Date.UTC(2023, 0, 4, 23, 59, 0),
    );
  });

  it("keeps a typed time on that first Monday", () => {
    expect(parseQuickAdd("Sync every monday 9am", WED, UTC).input.due_at).toBe(
      Date.UTC(2023, 0, 9, 9, 0, 0),
    );
  });

  it("still starts a plain 'every day' today", () => {
    expect(parseQuickAdd("Stretch every day", WED, UTC).input.due_at).toBe(
      Date.UTC(2023, 0, 4, 23, 59, 0),
    );
  });
});

describe("parseQuickAdd — impossible dates", () => {
  const UTC = { timeZone: "UTC" };
  const JAN2 = Date.UTC(2023, 0, 2, 10, 0, 0);

  it("leaves 'feb 30' in the title instead of rolling it into March", () => {
    for (const text of ["Party feb 30", "Party 30 feb", "Party apr 31"]) {
      const r = parseQuickAdd(text, JAN2, UTC);
      expect(r.input.due_at).toBeUndefined();
      expect(r.title).toBe(text);
      expect(r.dateMatch).toBeUndefined();
    }
  });

  it("takes 'feb 29' in the next year that has one", () => {
    expect(parseQuickAdd("Party feb 29", JAN2, UTC).input.due_at).toBe(
      Date.UTC(2024, 1, 29, 23, 59, 0),
    );
  });
});

describe("parseQuickAdd — Danish weekday words", () => {
  it("are plain words outside Danish", () => {
    for (const language of [undefined, "en"]) {
      const r = parseQuickAdd("Call the man", NOW, { language });
      expect(r.input.due_at).toBeUndefined();
      expect(r.title).toBe("Call the man");
      expect(parseQuickAdd("Feed every man", NOW, { language }).input.recurrence).toBeUndefined();
    }
  });

  it("are weekdays in Danish", () => {
    const r = parseQuickAdd("Ring til Bo man", NOW, { language: "da-DK" });
    expect(r.input.due_at).toBe(day(2023, 0, 2));
    expect(r.title).toBe("Ring til Bo");
  });
});

describe("parseQuickAdd — every UI language", () => {
  // [language, input, expected title, expected due (or undefined), expected rule (or undefined)]
  type Case = [string, string, string, number | undefined, string | undefined];
  const MO = "FREQ=WEEKLY;BYDAY=MO";
  const BIWEEKLY = "FREQ=WEEKLY;INTERVAL=2";
  const cases: Case[] = [
    // English
    ["en", "Meet on friday", "Meet", day(2023, 0, 6), undefined],
    ["en", "Ping in a week", "Ping", day(2023, 0, 9), undefined],
    ["en", "Party 3rd of june", "Party", day(2023, 5, 3), undefined],
    ["en", "Call the man at 5 lakes", "Call the man at 5 lakes", undefined, undefined],
    // Danish
    ["da", "Tandlæge i morgen kl 17", "Tandlæge", day(2023, 0, 3, 17, 0), undefined],
    ["da", "Fest den 3. juni", "Fest", day(2023, 5, 3), undefined],
    ["da", "Ring på fredag", "Ring", day(2023, 0, 6), undefined],
    ["da", "Lav middag", "Lav middag", undefined, undefined],
    // German
    ["de", "Zahnarzt morgen um 17 Uhr", "Zahnarzt", day(2023, 0, 3, 17, 0), undefined],
    ["de", "Bericht übermorgen", "Bericht", day(2023, 0, 4), undefined],
    ["de", "Bericht uebermorgen", "Bericht", day(2023, 0, 4), undefined],
    ["de", "Steuern am Freitag", "Steuern", day(2023, 0, 6), undefined],
    ["de", "Review nächsten Montag", "Review", day(2023, 0, 9), undefined],
    ["de", "Ping in 3 Tagen", "Ping", day(2023, 0, 5), undefined],
    ["de", "Ping in einer Woche", "Ping", day(2023, 0, 9), undefined],
    ["de", "Geburtstag 15. März", "Geburtstag", day(2023, 2, 15), undefined],
    ["de", "Gießen jeden Montag", "Gießen", day(2023, 0, 2), MO],
    ["de", "Putzen alle 2 Wochen", "Putzen", day(2023, 0, 2), BIWEEKLY],
    ["de", "Lesen täglich", "Lesen", day(2023, 0, 2), "FREQ=DAILY"],
    // Spanish
    ["es", "Dentista mañana a las 17", "Dentista", day(2023, 0, 3, 17, 0), undefined],
    ["es", "Llamar manana", "Llamar", day(2023, 0, 3), undefined],
    ["es", "Informe pasado mañana", "Informe", day(2023, 0, 4), undefined],
    ["es", "Pagar el viernes", "Pagar", day(2023, 0, 6), undefined],
    ["es", "Revisar el próximo lunes", "Revisar", day(2023, 0, 9), undefined],
    ["es", "Revisar en 3 días", "Revisar", day(2023, 0, 5), undefined],
    ["es", "Cumpleaños 15 de marzo", "Cumpleaños", day(2023, 2, 15), undefined],
    ["es", "Regar cada lunes", "Regar", day(2023, 0, 2), MO],
    ["es", "Limpiar cada 2 semanas", "Limpiar", day(2023, 0, 2), BIWEEKLY],
    ["es", "Leer todos los días", "Leer", day(2023, 0, 2), "FREQ=DAILY"],
    // French
    ["fr", "Dentiste demain à 17h30", "Dentiste", day(2023, 0, 3, 17, 30), undefined],
    ["fr", "Rapport après-demain", "Rapport", day(2023, 0, 4), undefined],
    ["fr", "Réunion lundi prochain", "Réunion", day(2023, 0, 9), undefined],
    ["fr", "Point la semaine prochaine", "Point", day(2023, 0, 9), undefined],
    ["fr", "Relancer dans 3 jours", "Relancer", day(2023, 0, 5), undefined],
    ["fr", "Anniversaire 1er mars", "Anniversaire", day(2023, 2, 1), undefined],
    ["fr", "Arroser tous les lundis", "Arroser", day(2023, 0, 2), MO],
    ["fr", "Ménage toutes les 2 semaines", "Ménage", day(2023, 0, 2), BIWEEKLY],
    ["fr", "Paul a 17 ans", "Paul a 17 ans", undefined, undefined],
    // Italian
    ["it", "Dentista domani alle 17", "Dentista", day(2023, 0, 3, 17, 0), undefined],
    ["it", "Report dopodomani", "Report", day(2023, 0, 4), undefined],
    ["it", "Pagare venerdi", "Pagare", day(2023, 0, 6), undefined],
    ["it", "Riunione lunedì prossimo", "Riunione", day(2023, 0, 9), undefined],
    ["it", "Richiamare tra 3 giorni", "Richiamare", day(2023, 0, 5), undefined],
    ["it", "Compleanno 15 marzo", "Compleanno", day(2023, 2, 15), undefined],
    ["it", "Annaffiare ogni lunedì", "Annaffiare", day(2023, 0, 2), MO],
    ["it", "Pulire ogni 2 settimane", "Pulire", day(2023, 0, 2), BIWEEKLY],
    // Dutch
    ["nl", "Tandarts morgen om 17:00", "Tandarts", day(2023, 0, 3, 17, 0), undefined],
    ["nl", "Sport vandaag 17 uur", "Sport", day(2023, 0, 2, 17, 0), undefined],
    ["nl", "Rapport overmorgen", "Rapport", day(2023, 0, 4), undefined],
    ["nl", "Betalen op vrijdag", "Betalen", day(2023, 0, 6), undefined],
    ["nl", "Review volgende maandag", "Review", day(2023, 0, 9), undefined],
    ["nl", "Bellen over 3 dagen", "Bellen", day(2023, 0, 5), undefined],
    ["nl", "Verjaardag 15 maart", "Verjaardag", day(2023, 2, 15), undefined],
    ["nl", "Water geven elke maandag", "Water geven", day(2023, 0, 2), MO],
    ["nl", "Schoonmaken om de 2 weken", "Schoonmaken", day(2023, 0, 2), BIWEEKLY],
    // Polish
    ["pl", "Dentysta jutro o 17:00", "Dentysta", day(2023, 0, 3, 17, 0), undefined],
    ["pl", "Raport pojutrze", "Raport", day(2023, 0, 4), undefined],
    ["pl", "Zapłacić w piątek", "Zapłacić", day(2023, 0, 6), undefined],
    ["pl", "Spotkanie w następny poniedziałek", "Spotkanie", day(2023, 0, 9), undefined],
    ["pl", "Spotkanie w przyszłym tygodniu", "Spotkanie", day(2023, 0, 9), undefined],
    ["pl", "Zadzwonić za 3 dni", "Zadzwonić", day(2023, 0, 5), undefined],
    ["pl", "Zadzwonić za tydzień", "Zadzwonić", day(2023, 0, 9), undefined],
    ["pl", "Urodziny 15 marca", "Urodziny", day(2023, 2, 15), undefined],
    ["pl", "Sprzątać co 2 tygodnie", "Sprzątać", day(2023, 0, 2), BIWEEKLY],
    ["pl", "Czytać codziennie", "Czytać", day(2023, 0, 2), "FREQ=DAILY"],
    ["pl", "Rozmowa o 2 projektach", "Rozmowa o 2 projektach", undefined, undefined],
    // Portuguese
    ["pt", "Dentista amanhã às 17h", "Dentista", day(2023, 0, 3, 17, 0), undefined],
    ["pt", "Relatório depois de amanhã", "Relatório", day(2023, 0, 4), undefined],
    ["pt", "Pagar na sexta", "Pagar", day(2023, 0, 6), undefined],
    ["pt", "Revisar na próxima segunda", "Revisar", day(2023, 0, 9), undefined],
    ["pt", "Ligar em 3 dias", "Ligar", day(2023, 0, 5), undefined],
    ["pt", "Aniversário 15 de março", "Aniversário", day(2023, 2, 15), undefined],
    ["pt", "Regar toda segunda", "Regar", day(2023, 0, 2), MO],
    ["pt", "Limpar a cada 2 semanas", "Limpar", day(2023, 0, 2), BIWEEKLY],
    ["pt", "Ler diariamente", "Ler", day(2023, 0, 2), "FREQ=DAILY"],
  ];

  it.each(cases)("%s: %s", (language, text, title, due, rule) => {
    const r = parseQuickAdd(text, NOW, { language });
    expect(r.title).toBe(title);
    expect(r.input.due_at).toBe(due);
    expect(r.input.recurrence).toBe(rule);
  });

  it("keeps English working in every language", () => {
    for (const language of ["da", "de", "es", "fr", "it", "nl", "pl", "pt", "pt-BR"]) {
      const r = parseQuickAdd("Call tomorrow 5pm every! 2 weeks", NOW, { language });
      expect(r.title, language).toBe("Call");
      expect(r.input.due_at, language).toBe(day(2023, 0, 3, 17, 0));
      expect(r.input.recurrence, language).toBe("FREQ=WEEKLY;INTERVAL=2;MODE=COMPLETION");
    }
  });

  it("reads a language's words only in that language", () => {
    // Danish "i morgen" and German "morgen" stay text in English.
    expect(parseQuickAdd("Køb mælk i morgen", NOW).input.due_at).toBeUndefined();
    expect(parseQuickAdd("Guten morgen", NOW, { language: "en" }).title).toBe("Guten morgen");
  });
});
