import { z, type ZodErrorMap } from "zod";

/**
 * pt-BR wording for Zod's built-in issues, installed globally on import.
 *
 * Every wire contract here is a Zod schema, and both the API (`ZodValidationPipe`, which sends
 * the issue messages back as the 400 body) and the web forms render those messages verbatim.
 * Without this map a missing field reads "Required" and a bad id "Invalid uuid" -- English text
 * in an otherwise Portuguese product. Messages a schema sets itself (`.regex(re, "…")`) still
 * win; this only replaces Zod's defaults.
 *
 * Installed from `index.ts`, so any consumer that imports `@crop/shared` gets it. pnpm resolves
 * one `zod` for the workspace, so the API's own `zod` import shares this same global map.
 */
const sizeNoun = (type: string): string => {
  switch (type) {
    case "string":
      return "caractere(s)";
    case "array":
    case "set":
      return "item(ns)";
    default:
      return "";
  }
};

export const ptBrErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === z.ZodParsedType.undefined || issue.received === z.ZodParsedType.null) {
        return { message: "Campo obrigatório" };
      }
      return { message: "Valor em formato inválido" };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === "email") return { message: "E-mail inválido" };
      if (issue.validation === "uuid") return { message: "Identificador inválido" };
      if (issue.validation === "url") return { message: "URL inválida" };
      if (issue.validation === "datetime" || issue.validation === "date") return { message: "Data inválida" };
      return { message: "Formato inválido" };
    case z.ZodIssueCode.too_small: {
      if (issue.type === "string" && issue.minimum === 1) return { message: "Campo obrigatório" };
      const noun = sizeNoun(issue.type);
      if (noun) return { message: `Deve ter no mínimo ${issue.minimum} ${noun}` };
      return { message: `Deve ser no mínimo ${issue.minimum}` };
    }
    case z.ZodIssueCode.too_big: {
      const noun = sizeNoun(issue.type);
      if (noun) return { message: `Deve ter no máximo ${issue.maximum} ${noun}` };
      return { message: `Deve ser no máximo ${issue.maximum}` };
    }
    case z.ZodIssueCode.invalid_enum_value:
      return { message: "Opção inválida" };
    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: "Valor inválido" };
    case z.ZodIssueCode.invalid_date:
      return { message: "Data inválida" };
    case z.ZodIssueCode.not_multiple_of:
      return { message: `Deve ser múltiplo de ${issue.multipleOf}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Campo(s) não permitido(s): ${issue.keys.join(", ")}` };
    case z.ZodIssueCode.custom:
      return { message: ctx.defaultError === "Invalid input" ? "Valor inválido" : ctx.defaultError };
    default:
      return { message: "Valor inválido" };
  }
};

z.setErrorMap(ptBrErrorMap);
