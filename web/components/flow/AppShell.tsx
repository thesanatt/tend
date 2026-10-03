"use client";

import { useEffect, type ReactNode } from "react";
import { I18nProvider, preferredLang, useI18n } from "@/lib/i18n";
import AppFooter from "./AppFooter";
import AppHeader from "./AppHeader";
import { ExitControl } from "./ExitControl";
import { FlowProvider } from "./FlowProvider";

function SkipLink() {
  const { t } = useI18n();
  return (
    <a className="skip" href="#main">
      {t.shell.skip}
    </a>
  );
}

// A browser set to Spanish gets Spanish once it loads; the switch in the header changes it any time.
function BrowserLanguage() {
  const { setLang } = useI18n();
  useEffect(() => {
    if (preferredLang() === "es") setLang("es");
  }, [setLang]);
  return null;
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <BrowserLanguage />
      <FlowProvider>
        <SkipLink />
        <ExitControl />
        <AppHeader />
        <main id="main">{children}</main>
        <AppFooter />
      </FlowProvider>
    </I18nProvider>
  );
}
