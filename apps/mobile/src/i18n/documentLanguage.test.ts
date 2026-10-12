import i18n, { setDocumentLanguage } from "./index";

describe("setDocumentLanguage", () => {
  const g = globalThis as { document?: { documentElement: { lang: string } } };
  const original = g.document;

  beforeEach(() => {
    g.document = { documentElement: { lang: "en" } };
  });
  afterAll(() => {
    g.document = original;
  });

  it("sets <html lang>, with the region for Brazilian Portuguese", () => {
    setDocumentLanguage("da");
    expect(g.document?.documentElement.lang).toBe("da");
    setDocumentLanguage("pt");
    expect(g.document?.documentElement.lang).toBe("pt-BR");
  });

  it("follows i18next language changes", async () => {
    await i18n.changeLanguage("de");
    expect(g.document?.documentElement.lang).toBe("de");
    await i18n.changeLanguage("en");
    expect(g.document?.documentElement.lang).toBe("en");
  });

  it("does nothing without a document", () => {
    g.document = undefined;
    expect(() => setDocumentLanguage("fr")).not.toThrow();
  });
});
