import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ptBR from "./locales/pt-BR.js";

/**
 * pt-BR only, no language detector: the whole app is hardcoded English today, and this is
 * the first page to move off that (see docs/architecture.md). Adding a second real language
 * or auto-detection is a separate decision for whenever a second locale actually exists --
 * doing it now would just be unused plumbing.
 */
void i18n.use(initReactI18next).init({
  lng: "pt-BR",
  fallbackLng: "pt-BR",
  defaultNS: "common",
  resources: {
    "pt-BR": ptBR,
  },
  interpolation: {
    // React already escapes interpolated values when rendering -- i18next's own escaping on
    // top of that would double-escape entities like `&`.
    escapeValue: false,
  },
});

export default i18n;
