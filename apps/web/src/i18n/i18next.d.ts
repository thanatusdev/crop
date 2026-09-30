import ptBR from "./locales/pt-BR.js";

/**
 * Module augmentation so every `t("namespace:key")` call (and `useTranslation("namespace")`)
 * is checked against `pt-BR.ts`'s actual shape at compile time -- a typo'd or renamed key
 * fails `tsc`, not silently renders its own key name at runtime. `pt-BR` is authoritative
 * here (not some separate hand-written schema) since it's the only locale that exists.
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof ptBR;
  }
}
