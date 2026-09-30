-- AlterTable
ALTER TABLE "queue_entries" ADD COLUMN     "teleoperationNotes" TEXT;

-- CreateTable
CREATE TABLE "exam_messages" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "queueEntryId" TEXT,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_shortcuts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_shortcuts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_messages_equipmentId_createdAt_idx" ON "exam_messages"("equipmentId", "createdAt");

-- CreateIndex
CREATE INDEX "exam_messages_queueEntryId_idx" ON "exam_messages"("queueEntryId");

-- CreateIndex
CREATE INDEX "message_shortcuts_tenantId_idx" ON "message_shortcuts"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "message_shortcuts_tenantId_code_key" ON "message_shortcuts"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "exam_messages" ADD CONSTRAINT "exam_messages_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_messages" ADD CONSTRAINT "exam_messages_queueEntryId_fkey" FOREIGN KEY ("queueEntryId") REFERENCES "queue_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_shortcuts" ADD CONSTRAINT "message_shortcuts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed every existing clinic with the six default quick-reply shortcuts, so a clinic that
-- exists before this feature ships opens the exam chat to real, usable buttons rather than an
-- empty list nobody has clicked "Criar Atalho" for yet. `createdByUserId` stays NULL -- no
-- human admin actually created these, the same "no attributed actor" convention audit rows
-- already use for system/seed-originated writes. `ON CONFLICT DO NOTHING` against the
-- (tenantId, code) unique index makes this safe to run more than once, the same defensive
-- posture `operator_provider_role_split`'s own migration documents choosing for itself.
INSERT INTO "message_shortcuts" ("id", "tenantId", "code", "label", "body", "createdAt")
SELECT gen_random_uuid(), t."id", shortcut.code, shortcut.label, shortcut.body, now()
FROM "tenants" t
CROSS JOIN (
  VALUES
    ('CONT', 'Contraste Administrado', 'Contraste administrado (50ml).'),
    ('PL',   'Punção Venosa',          'Acesso venoso puncionado com sucesso.'),
    ('TB',   'Travesseiro/Apoio',      'Travesseiro / apoio de posicionamento fornecido.'),
    ('INT',  'Intérprete/Acompanhante','Intérprete / acompanhante presente na sala.'),
    ('TL',   'Troca de Lençol',        'Lençol / toalha trocado(a).'),
    ('PSM',  'Posicionamento Supino',  'Paciente posicionado em decúbito dorsal (supino).')
) AS shortcut(code, label, body)
WHERE t."type" = 'CLINIC'
ON CONFLICT ("tenantId", "code") DO NOTHING;
