// Rule summaries are written in English. In Spanish, Tend asks Chrome's on-device Translator API for
// a translation, and only when the model is already on the device: nothing is sent anywhere and
// nothing is downloaded without the survivor asking. Quotes of the law are never translated.

interface TranslatorLike {
  translate(text: string): Promise<string>;
}

interface TranslatorApi {
  availability(opts: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(opts: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorLike>;
}

let translator: Promise<TranslatorLike | null> | null = null;
const cache = new Map<string, Promise<string | null>>();

function api(): TranslatorApi | null {
  const t = (globalThis as { Translator?: Partial<TranslatorApi> }).Translator;
  return t && typeof t.availability === "function" && typeof t.create === "function" ? (t as TranslatorApi) : null;
}

async function open(): Promise<TranslatorLike | null> {
  const t = api();
  if (!t) return null;
  const opts = { sourceLanguage: "en", targetLanguage: "es" };
  if ((await t.availability(opts)) !== "available") return null;
  return t.create(opts);
}

export function toSpanish(text: string): Promise<string | null> {
  let hit = cache.get(text);
  if (!hit) {
    translator ??= open().catch(() => null);
    hit = translator.then((tr) => (tr ? tr.translate(text) : null)).catch(() => null);
    cache.set(text, hit);
  }
  return hit;
}

export function resetTranslatorForTests() {
  translator = null;
  cache.clear();
}
