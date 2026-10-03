"use client";

// English and Spanish for every string in the survivor flow. The dictionaries are typed: Spanish must
// have every key English has, with the same arguments, or the build fails.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type Dict } from "./en";
import { es } from "./es";
import {
  describeSpan,
  formatDate,
  formatMoney,
  formatMoneyShort,
  formatTime,
  listJoin,
  orJoin,
  type Lang,
} from "./format";
import { toSpanish } from "./translate";

export type { Dict, Lang };
export { LANGS } from "./format";

export const DICTS: Record<Lang, Dict> = { en, es };

export interface Formatters {
  date(iso: string, style?: "long" | "short" | "numeric"): string;
  time(ts: string): string;
  money(cents: number): string;
  moneyShort(cents: number): string;
  span(fromIso: string, toIso: string): string | null;
  and(items: string[]): string;
  or(items: string[]): string;
}

export function formatters(lang: Lang): Formatters {
  return {
    date: (iso, style) => formatDate(iso, lang, style),
    time: (ts) => formatTime(ts, lang),
    money: formatMoney,
    moneyShort: formatMoneyShort,
    span: (a, b) => describeSpan(a, b, lang),
    and: (items) => listJoin(items, lang),
    or: (items) => orJoin(items, lang),
  };
}

interface I18n {
  lang: Lang;
  setLang(lang: Lang): void;
  t: Dict;
  f: Formatters;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, initial = "en" }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18n>(() => ({ lang, setLang, t: DICTS[lang], f: formatters(lang) }), [lang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n needs I18nProvider");
  return ctx;
}

// A browser that asks for Spanish gets Spanish, once, after hydration.
export function preferredLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  return (navigator.languages ?? [navigator.language]).some((l) => /^es\b/i.test(l)) ? "es" : "en";
}

// Plain-English rule summaries, shown in Spanish when the device can translate them on its own.
export function useSummary(text: string | undefined): { text: string; original: boolean } {
  const { lang } = useI18n();
  const [translated, setTranslated] = useState<{ source: string; text: string } | null>(null);

  useEffect(() => {
    if (lang !== "es" || !text) return;
    let live = true;
    toSpanish(text).then((out) => {
      if (live && out) setTranslated({ source: text, text: out });
    });
    return () => {
      live = false;
    };
  }, [lang, text]);

  if (!text) return { text: "", original: false };
  if (lang === "en") return { text, original: false };
  return translated?.source === text ? { text: translated.text, original: false } : { text, original: true };
}
