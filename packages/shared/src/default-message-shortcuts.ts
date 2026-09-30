/**
 * The six quick-reply shortcuts every `CLINIC` tenant gets, seeded twice over: once
 * historically, in `exam_chat_and_shortcuts`'s own migration SQL (for every clinic that
 * existed before this feature shipped), and once for every clinic created after that, by
 * `SeedDefaultShortcutsHandler` reacting to `TenantCreatedEvent`. Both sites import this one
 * array rather than each hard-coding their own copy, so the two can never drift apart the way
 * they would if the migration's `VALUES (...)` rows were retyped here by hand.
 *
 * The migration itself is not re-run by this file, and cannot be -- editing this array does
 * not retroactively change what already-seeded clinics have; it only changes what the next
 * newly created clinic gets. Content mirrors `RadLink`'s own "Atalhos Clínicos" mock buttons
 * (`CONT`, `PL`, `TB`, `INT`, `TL`, `PSM`), the same real-clinical-shorthand precedent
 * `MessageShortcut`'s own docstring documents.
 */
export interface DefaultMessageShortcut {
  code: string;
  label: string;
  body: string;
}

export const DEFAULT_MESSAGE_SHORTCUTS: readonly DefaultMessageShortcut[] = [
  { code: "CONT", label: "Contraste Administrado", body: "Contraste administrado (50ml)." },
  { code: "PL", label: "Punção Venosa", body: "Acesso venoso puncionado com sucesso." },
  { code: "TB", label: "Travesseiro/Apoio", body: "Travesseiro / apoio de posicionamento fornecido." },
  { code: "INT", label: "Intérprete/Acompanhante", body: "Intérprete / acompanhante presente na sala." },
  { code: "TL", label: "Troca de Lençol", body: "Lençol / toalha trocado(a)." },
  { code: "PSM", label: "Posicionamento Supino", body: "Paciente posicionado em decúbito dorsal (supino)." },
];
