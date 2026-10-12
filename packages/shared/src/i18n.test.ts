import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resources } from "./i18n";
import en from "./locales/en.json";

/** Flatten a catalog into dot-separated key paths, so catalogs can be diffed key by key. */
function flatten(node: unknown, prefix = ""): string[] {
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null ? flatten(value, path) : [path];
  });
}

/**
 * The non-ASCII letters each language must keep. The admin-panel commit once wrote `da.json`
 * with every æ/ø/å stripped; users saw "Nr den er sljet fra" where the copy reads "Når den
 * er slået fra"; so a locale now declares the characters its copy depends on, and a future
 * edit or tool that strips them fails here instead of shipping. Extend the map as new
 * languages are added.
 */
const REQUIRED_LETTERS: Record<string, string[]> = {
  da: ["æ", "ø", "å", "é"],
  de: ["ä", "ö", "ü", "ß"],
  es: ["á", "é", "í", "ó", "ñ"],
  fr: ["é", "è", "à", "ç"],
  it: ["à", "è", "ù"],
  pl: ["ą", "ę", "ł", "ś", "ż"],
  pt: ["ã", "ç", "é", "õ"],
};

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * English's keys as `code` must declare them. A plural English writes as `_one`/`_other` takes
 * every CLDR form of the language (Polish `_one`/`_few`/`_many`/`_other`). One written as a bare
 * key plus `_other` keeps the bare key, which i18next falls back to for a missing form, as its
 * singular, plus every form but `_one`: without them a Polish "3" or a Spanish "1 000 000" would
 * read in the singular.
 */
function expectedKeys(code: string): string[] {
  const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  const enKeys = flatten(en);
  const keys = new Set(enKeys.filter((k) => !PLURAL_SUFFIX.test(k)));
  for (const k of enKeys) {
    if (!k.endsWith("_other")) continue;
    const base = k.slice(0, -"_other".length);
    const bare = !enKeys.includes(`${base}_one`);
    for (const form of forms) if (!(bare && form === "one")) keys.add(`${base}_${form}`);
  }
  return [...keys].sort();
}

/**
 * The stripped/transliterated residue of real Danish words, from that same corruption event
 * ("Prøv" → "Prov", "længere" → "laengere", "når" → "nar"). Guards against *partial*
 * corruption, where a string keeps some of the language's characters but loses others.
 */
const CORRUPT_FRAGMENTS: Record<string, string[]> = {
  da: [
    "Nr ",
    "Prov igen",
    "Genabn",
    "Udlber",
    "Ulaste",
    "laengere",
    "vaerd",
    "skaerm",
    "Nuvaerende",
    "aendringer",
    "Hjaelp",
    "Gor til",
    "Sog efter",
    " nar ",
    " pa ",
  ],
};

const translationOf = (code: string): object => {
  const catalog = (resources as Record<string, { translation: object }>)[code];
  if (!catalog) throw new Error(`unknown locale: ${code}`);
  return catalog.translation;
};

describe("i18n catalogs", () => {
  it("every locale declares exactly the English keys, in its own plural forms", () => {
    for (const code of Object.keys(resources)) {
      if (code === "en") continue;
      expect(flatten(translationOf(code)).sort(), code).toEqual(expectedKeys(code));
    }
  });

  it("every locale file decodes as strict UTF-8 with no replacement characters", async () => {
    for (const code of Object.keys(resources)) {
      const bytes = await readFile(new URL(`./locales/${code}.json`, import.meta.url));
      // `fatal: true` throws on any byte sequence that is not valid UTF-8, so a file saved in
      // Latin-1 or with truncated multibyte characters cannot slip through.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(text, code).not.toContain("\uFFFD");
    }
  });

  it("every locale still contains its language's special characters", () => {
    for (const [code, letters] of Object.entries(REQUIRED_LETTERS)) {
      const text = JSON.stringify(translationOf(code));
      for (const letter of letters ?? []) {
        expect(text, `${code}: lost the character "${letter}"`).toContain(letter);
      }
    }
  });

  it("no locale contains a known-corrupt fragment", () => {
    for (const [code, fragments] of Object.entries(CORRUPT_FRAGMENTS)) {
      const text = JSON.stringify(translationOf(code));
      for (const fragment of fragments ?? []) {
        expect(text, `${code}: corrupt fragment "${fragment}"`).not.toContain(fragment);
      }
    }
  });
});
