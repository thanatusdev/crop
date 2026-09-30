import { execSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, getLatestResetLink, getLatestInvitationLink, getLiveTotpCode, selectRadixOption } from "./helpers.js";

/**
 * Scans every distinct page in apps/web with axe-core, against the real seeded demo accounts
 * (see README.md's Seeded demo accounts / `make demo`) -- not a mocked DOM fixture, the actual
 * rendered app, logged in through the real (mandatory-2FA) auth flow. This is the automated
 * check that a prior verification pass found never existed: the a11y fixes made earlier in
 * this project's history (landmarks, labels, focus-visible, live regions -- see
 * docs/architecture.md) were previously provable only by manual/AI-driven Playwright sessions
 * during development, never by a repeatable test a future regression would actually fail.
 *
 * Deliberately local/on-demand only (`pnpm --filter @crop/web test:a11y`), not part of
 * `.github/workflows/ci.yml` -- see playwright.config.ts's own docstring for why.
 */

const ADMIN = { email: "admin@alpha.crop.health", password: "SenhaForte123!" };
// Set by "Admin users page" below, read by "Activate account page" -- safe given this
// project's `workers: 1, fullyParallel: false` (see playwright.config.ts's own docstring):
// tests in this file always run sequentially, in declaration order.
let lastInvitedEmail = "";
const OPERATOR = { email: "operator@central.crop.health", password: "SenhaForte123!" };
const SUPERADMIN = { email: "superadmin@crop.health", password: "SenhaForte123!" };
const NURSE = { email: "enfermagem@alpha.crop.health", password: "SenhaForte123!" };

test.beforeAll(() => {
  // Idempotent by design (infra/seeds/bootstrap-superadmin.ts) -- ensures the superadmin
  // fixture exists even on a freshly-seeded demo stack, without requiring the developer to
  // have already run `make bootstrap-superadmin` by hand first.
  execSync("pnpm bootstrap:superadmin", {
    cwd: path.resolve(import.meta.dirname, "../../../.."),
    stdio: "inherit",
  });
});

test.beforeEach(async ({ page }) => {
  // Respect `prefers-reduced-motion` for every test in this file, not just as a matter of
  // taste: shadcn's `Dialog` (and other Radix primitives) animate open over ~200ms
  // (`tw-animate-css`'s `animate-in`/`fade-in-0`/`zoom-in-95`), and axe-core scans whatever
  // is painted the instant it runs -- a scan fired right after `dialog.waitFor()` can sample
  // a still-transitioning frame (measurably lower opacity/contrast, mid zoom-in) and flag a
  // "color-contrast" violation that has nothing to do with the dialog's real, settled
  // appearance. `index.css` has a real `@media (prefers-reduced-motion: reduce)` rule for
  // this (a genuine WCAG 2.3.3 accessibility feature, not test-only); the *context option*
  // meant to trigger it (`use: { reducedMotion: "reduce" }` in playwright.config.ts) turned
  // out not to reliably flip `matchMedia` in this Playwright/Chromium combination --
  // confirmed by direct comparison, not assumption. The imperative call below does, every
  // time, so it's what this suite actually relies on.
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test("Login page", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("heading", { name: "RadLink" }).waitFor();
  await expectNoViolations(page);
});

test("Recovery page: request tab, the send-confirmation modal, and the reset tab", async ({ page }) => {
  await page.goto("/recuperar-senha");
  await page.getByRole("tab", { name: "Solicitar Token" }).waitFor();
  await expectNoViolations(page);

  // The confirmation modal is the first dialog anywhere in this app (see Modal.tsx) -- axe
  // only scans rendered DOM, so it has to be scanned while actually open, not just mounted.
  await page.getByLabel("E-mail").fill("a11y-recovery@test.crop.health");
  await page.getByRole("button", { name: "Enviar" }).click();
  const dialog = page.getByRole("dialog", { name: "Link de Acesso Enviado" });
  await dialog.waitFor();
  await expectNoViolations(page);

  // Focus must have moved into the dialog (see Modal.tsx, now shadcn/Radix's `Dialog`), not
  // stayed on the "Enviar" button underneath it. Radix's own default initial-focus target is
  // the first focusable descendant (here, "OK ✓") -- the WAI-ARIA APG dialog pattern's own
  // recommendation, and a genuine improvement over the hand-rolled `Modal` this replaced,
  // which always focused the dialog's outer container instead. Asserted as "focus landed
  // somewhere inside the dialog", not the specific element, so this doesn't overspecify
  // Radix's own internals.
  await expect(dialog.locator(":focus")).toBeVisible();

  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  // And returned to the trigger on close.
  await expect(page.getByRole("button", { name: "Enviar" })).toBeFocused();

  await page.getByRole("tab", { name: "Nova Senha" }).click();
  await page.getByLabel("Token de acesso").waitFor();
  await expectNoViolations(page);
});

test("Recovery page: the rich reset screen reached via a real emailed link", async ({ page }) => {
  const email = "auditor@alpha.crop.health";
  await page.goto("/recuperar-senha");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Enviar" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "OK" }).click();

  await page.goto(getLatestResetLink(email));

  // Stepper, identity card, and the initial (empty) strength meter/checklist state.
  await page.getByText("Cadastrar Nova Senha").waitFor();
  await page.getByText("Auditor", { exact: true }).waitFor();
  await expectNoViolations(page);

  // A password that satisfies the four context-free rules but fails the fifth (contains
  // this account's own email local-part) -- the state most likely to have an a11y issue,
  // since it's the one where the checklist shows a real, live "not satisfied" item.
  await page.locator("#set-password-new").fill("Auditor123!");
  await page.locator("#set-password-confirm").fill("Auditor123!");
  await page.getByText("Senha forte").waitFor();
  await expectNoViolations(page);

  // A password that actually passes -- submit disabled/enabled transition, then the
  // success state. Unique per run (not a fixed literal): this reuses the shared
  // `auditor@alpha.crop.health` fixture rather than a one-off account, so a fixed password
  // would pass the first time this test is ever run and then fail every subsequent run
  // with PASSWORD_REUSED, since it would already be sitting in that account's own history.
  const newPassword = `Girafa${Date.now()}!`;
  await page.locator("#set-password-new").fill(newPassword);
  await page.locator("#set-password-confirm").fill(newPassword);
  const submit = page.getByRole("button", { name: "Salvar Nova Senha" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.getByText("Senha redefinida com sucesso").waitFor();
  await expectNoViolations(page);
});

test("ForcePasswordChangePage: an admin password-reset's temp password forces a change on next login", async ({ page }) => {
  // A dedicated, freshly created account for this one test -- not one of the shared
  // ADMIN/OPERATOR/SUPERADMIN fixtures every other test in this file reuses, so mutating its
  // password (which this test's whole point is to do) can't affect anything else in the
  // suite, this run or a later one. NURSING, not OPERATOR: since the role-model inversion
  // (see packages/shared/src/roles.ts), OPERATOR belongs to an OPERATOR_PROVIDER tenant only
  // -- a CLINIC_ADMIN like ADMIN below can no longer create one at all (ROLE_GRANTS would
  // 403 the POST below).
  //
  // Rewritten from an earlier version that POSTed `{ password: tempPassword }` straight to
  // `/users` and logged in with it directly -- CreateUserRequestSchema has no `password`
  // field at all anymore (every HTTP-created account is invitation-only, see
  // UsersController's own comment: "every HTTP-created account goes through the invitation
  // flow ... never an admin-typed password"), and it also never sent `clinicTenantIds`,
  // which NURSING has required since the Manager/Supervisor/Nursing membership model landed.
  // `mustChangePassword` still exists and still routes here -- it just has one live producer
  // now, an admin *resetting* an existing account's password (`POST /users/:id/reset-password`,
  // AdminUsersPage's own "Redefinir senha" `KeyRound` button), not account creation. So this
  // now: invites the account for real, activates it (own password, no forced change --
  // ChangePasswordHandler's `mustChangePassword: false` on that path), lets it complete
  // first-login MFA enrollment, and only then has the admin reset its password -- the one
  // remaining path that actually produces the screen this test is about.
  await login(page, ADMIN.email, ADMIN.password);
  const adminToken = await page.evaluate(() => localStorage.getItem("crop.accessToken"));
  const me = await page.request
    .get("http://localhost:3000/auth/me", { headers: { Authorization: `Bearer ${adminToken}` } })
    .then((r) => r.json());

  const email = `a11y-forced-change-${Date.now()}@test.crop.health`;
  const createRes = await page.request.post("http://localhost:3000/users", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { email, role: "NURSING", firstName: "Novo", lastName: "Colega", clinicTenantIds: [me.tenantId] },
  });
  expect(createRes.ok()).toBeTruthy();
  const { userId } = await createRes.json();

  // Activation: the user's own choice of password, via the real emailed link -- no UI needed
  // for this part, since the UI's own rendering of that same form is already covered by
  // "Activate account page" below.
  const activationLink = getLatestInvitationLink(email);
  const activationToken = new URL(activationLink).searchParams.get("token");
  const initialPassword = `Xk9!qLp7zM${Date.now()}`;
  const activateRes = await page.request.post("http://localhost:3000/auth/activate", {
    data: { token: activationToken, newPassword: initialPassword },
  });
  expect(activateRes.ok()).toBeTruthy();

  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(initialPassword);
  await page.getByRole("button", { name: "Entrar" }).click();

  // First-ever login: mandatory MFA enrollment, same as any brand-new account -- enrolling
  // returns to the credentials step (LoginPage's own `setStep({ name: "credentials" })`), not
  // a session, so a second real login is what actually reaches VerifyMfaHandler.
  await page.getByLabel("Digite o código gerado para confirmar").waitFor();
  await page.getByLabel("Digite o código gerado para confirmar").fill(await getLiveTotpCode(email));
  await page.getByRole("button", { name: "Confirmar cadastro" }).click();

  await page.getByLabel("E-mail").waitFor();
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(initialPassword);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByLabel("Código").waitFor();
  await page.getByLabel("Código").fill(await getLiveTotpCode(email));
  await page.getByRole("button", { name: "Verificar" }).click();
  await page.waitForURL("/enfermagem");

  // Now the admin resets it -- the one remaining path that sets `mustChangePassword: true`.
  const tempPassword = "TempReset123!";
  const resetRes = await page.request.post(`http://localhost:3000/users/${userId}/reset-password`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { newPassword: tempPassword },
  });
  expect(resetRes.ok()).toBeTruthy();

  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(tempPassword);
  await page.getByRole("button", { name: "Entrar" }).click();

  // MFA is enrolled already, so this reaches VerifyMfaHandler directly -- and the
  // admin-issued temp password routes straight to the forced-change screen instead of a
  // session.
  await page.getByLabel("Código").waitFor();
  await page.getByLabel("Código").fill(await getLiveTotpCode(email));
  await page.getByRole("button", { name: "Verificar" }).click();

  await page.waitForURL("**/trocar-senha");
  await page.getByText("Enfermagem", { exact: true }).waitFor();
  await page.getByText(email).waitFor();
  await expectNoViolations(page);

  await page.locator("#set-password-new").fill("Tucano8847%");
  await page.locator("#set-password-confirm").fill("Tucano8847%");
  await page.getByRole("button", { name: "Salvar Nova Senha" }).click();
  // NURSING lands on "/enfermagem" (see role-routes.ts) -- ChangePasswordHandler minted a
  // real session directly, so this is a completed login, not a redirect back to /login.
  await page.waitForURL("/enfermagem");
});

test("Dashboard page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  // `ConsoleShell` renders its `pageTitle` as a `<strong>` in the topbar, not a heading, so
  // this waits on the sidebar nav link instead. (Was `heading "Equipment"`, which stopped
  // existing when the admin pages moved into ConsoleShell -- see the note on the equipment
  // test below.)
  await page.getByRole("link", { name: "Painel" }).waitFor();
  await expectNoViolations(page);
});

test("Audit page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole("button", { name: "Log de Auditoria" }).click();
  await page.waitForURL("/audit");
  await page.getByRole("heading", { name: "Log de Auditoria" }).waitFor();
  await expectNoViolations(page);
});

test("Admin users page", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  // Navigates via ConsoleShell's sidebar. The `button "Manage users"` this used to click lived
  // on DashboardPage and was removed when that navigation moved into the shared shell -- see
  // the equipment test below for the same correction and why all of these needed it.
  await page.getByRole("link", { name: "Gestores & Usuários" }).click();
  await page.waitForURL("/admin/users");
  // "Usuários": AdminUsersPage's own pt-BR pass -- DashboardPage's "Manage users" button
  // that navigates here stays English (see docs/architecture.md's note on that seam).
  await page.getByRole("heading", { name: "Usuários" }).waitFor();
  await expectNoViolations(page);

  // Exercises the clinic multi-select fieldset (a CLINIC_ADMIN may only grant NURSING --
  // see roles.ts's ROLE_GRANTS -- which requires at least one clinic checked), then scans
  // the "invitation sent" success-banner state too. No password field anymore: POST /users
  // sends an activation link instead (see SendInvitationHandler).
  const email = `a11y-admin-created-${Date.now()}@test.crop.health`;
  lastInvitedEmail = email;
  await page.getByLabel("E-mail corporativo").fill(email);
  await page.getByLabel("Nome", { exact: true }).fill("Paulo");
  await page.getByLabel("Sobrenome", { exact: true }).fill("Andrade");
  await page.getByRole("checkbox", { name: "Clinica Alpha" }).check();
  const createButton = page.getByRole("button", { name: "Enviar convite" });
  await expect(createButton).toBeEnabled();
  await createButton.click();
  await page.getByText("Convite enviado.").waitFor();
  await expectNoViolations(page);
});

test("Activate account page (the invitation-link redemption flow)", async ({ page }) => {
  // Reuses the account POST /users just created in the previous test -- an unactivated
  // NURSING account with a real invitation email in the outbox.
  const activationLink = getLatestInvitationLink(lastInvitedEmail);
  await page.goto(activationLink.replace(/^https?:\/\/[^/]+/, ""));
  await page.getByRole("heading", { name: "Ative sua conta" }).waitFor();
  await expectNoViolations(page);

  const activationPassword = `Xk9!qLp7zM${Date.now()}`;
  await page.getByLabel("Nova Senha", { exact: true }).fill(activationPassword);
  await page.getByLabel("Confirme a nova senha", { exact: true }).fill(activationPassword);
  await page.getByRole("button", { name: "Salvar Nova Senha" }).click();
  await page.getByText("Conta ativada com sucesso.").waitFor();
  await expectNoViolations(page);
});

test("Admin equipment page: the registry listing, with filters applied", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  /*
   * Navigates via ConsoleShell's sidebar link, not a dashboard button.
   *
   * This whole file's navigation steps needed correcting: several tests still clicked
   * `button "Manage equipment"` / `"Manage users"` / `"Manage tenants"` on DashboardPage, which
   * stopped existing when those links moved into ConsoleShell's sidebar -- so those tests had
   * been failing on a missing locator, before axe ever got to scan anything. Found while adding
   * the equipment coverage below.
   */
  await page.getByRole("link", { name: "Equipamentos" }).click();
  await page.waitForURL("/admin/equipment");
  // pt-BR now (the equipment registry pass) -- DashboardPage's "Manage equipment" button that
  // navigates here is still English, the same seam AdminUsersPage's own note above describes.
  await page.getByRole("heading", { name: "Gestão de Equipamentos & Scanners" }).waitFor();
  await expectNoViolations(page);

  // The filtered state is scanned separately: it swaps the table for a "nothing matches" note
  // and updates two `aria-live` regions (the result count and the pagination summary), none of
  // which axe sees in the default state.
  await page.getByLabel("Buscar equipamento").fill("nao-existe-nenhum-equipamento-assim");
  await page.getByText("Nenhum equipamento corresponde aos filtros aplicados.").waitFor();
  await expectNoViolations(page);
});

test("Equipment form page: create, read-only view, and edit", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.goto("/admin/equipment/new");

  // The create form: four sections, the modality radio-card group (a real <fieldset> of real
  // radios -- see RadioCardGroup), and the operational toggle (a restyled checkbox).
  await page.getByRole("heading", { name: "Cadastrar Equipamento" }).waitFor();
  await expectNoViolations(page);

  const serial = `A11Y-SN-${Date.now()}`;
  await page.getByLabel("Nome do equipamento").fill("A11y Scanner");
  await page.getByLabel("Marca / fabricante").fill("Siemens");
  await page.getByLabel("Modelo").fill("Magnetom Vida 3.0T");
  await page.getByLabel("Número de série").fill(serial);
  await page.getByLabel("Identificador da sala / gantry").fill("Sala A11Y-01");
  await page.getByLabel("Data de instalação / homologação").fill("2025-06-15");
  await page.getByRole("radio", { name: /Tomografia Computadorizada/ }).check();
  await page.getByLabel("Endereço do PiKVM").fill("https://192.0.2.77");
  await page.getByLabel("Senha do PiKVM").fill("A11yPassword123!");
  await page.getByRole("button", { name: "Salvar equipamento" }).click();

  await page.waitForURL("/admin/equipment");
  const row = page.getByRole("row").filter({ hasText: serial });
  await row.waitFor();

  // Read-only view: every control disabled, the PiKVM password field absent entirely.
  await row.getByRole("link", { name: "Ver detalhes" }).click();
  await page.waitForURL(/\/admin\/equipment\/[^/]+$/);
  await page.getByRole("heading", { name: "Detalhes do Equipamento" }).waitFor();
  await expect(page.getByLabel("Nome do equipamento")).toBeDisabled();
  await expect(page.getByLabel("Senha do PiKVM")).toHaveCount(0);
  await expectNoViolations(page);

  await page.getByRole("link", { name: "Editar equipamento" }).click();
  await page.waitForURL(/\/admin\/equipment\/[^/]+\/edit$/);
  await page.getByRole("heading", { name: "Editar Equipamento" }).waitFor();
  await expect(page.getByLabel("Nome do equipamento")).toBeEnabled();
  await expectNoViolations(page);

  // Cleanup: retire the device this test registered, so repeated runs don't accumulate rows in
  // the demo stack's fleet (and so the deactivation confirmation modal gets scanned too --
  // it's a dialog, which axe only sees while actually open).
  await page.getByRole("link", { name: "Cancelar" }).click();
  await page.waitForURL("/admin/equipment");
  await page.getByRole("row").filter({ hasText: serial }).getByRole("button", { name: "Desativar" }).click();
  const dialog = page.getByRole("dialog", { name: "Desativar equipamento" });
  await dialog.waitFor();
  await expectNoViolations(page);
  await dialog.getByRole("button", { name: "Desativar" }).click();
  await expect(dialog).toBeHidden();
});

test("Admin units page: the registry listing, with filters applied", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.getByRole("link", { name: "Unidades" }).click();
  await page.waitForURL("/admin/units");
  await page.getByRole("heading", { name: "Gestão de Unidades Operacionais" }).waitFor();
  await expectNoViolations(page);

  // Same reasoning as the equipment listing's own filtered-state scan: swaps the table for
  // a "nothing matches" note and updates two `aria-live` regions axe doesn't see by default.
  await page.getByLabel("Buscar unidade").fill("nao-existe-nenhuma-unidade-assim");
  await page.getByText("Nenhuma unidade corresponde aos filtros aplicados.").waitFor();
  await expectNoViolations(page);
});

test("Unit form page: create, read-only view, and edit", async ({ page }) => {
  await login(page, ADMIN.email, ADMIN.password);
  await page.goto("/admin/units/new");

  // The create form: three sections, the modality checkbox-card group (a real <fieldset> of
  // real checkboxes -- see CheckboxCardGroup), and the operational toggle.
  await page.getByRole("heading", { name: "Cadastrar Nova Unidade" }).waitFor();
  await expectNoViolations(page);

  const cnes = `A11Y-CNES-${Date.now()}`;
  // Unlike equipment names (unconstrained), unit names are unique per clinic
  // (`units_clinicTenantId_lower_name_key`) -- deactivating at the end of this test doesn't
  // free the name, since deactivation is not deletion. A fixed literal here would collide
  // with the previous run's own leftover (deactivated, still-present) row and 409 on create.
  await page.getByLabel("Nome da unidade").fill(`A11y Unit ${cnes}`);
  await selectRadixOption(page, "Tipo de estabelecimento", "Laboratório");
  await page.getByLabel("Código CNES").fill(cnes);
  // `getByLabel("CEP", { exact: true })` doesn't work here: Playwright's exact-match against
  // a <label> compares raw textContent, which includes the hidden required-asterisk span's
  // "*" ("CEP*", not "CEP") -- unlike `getByRole`'s accessible-name computation, which
  // correctly excludes `aria-hidden` content per the accname spec. `getByRole` is also what's
  // needed anyway to disambiguate from "E-mail da recepção técnica", whose substring match
  // against plain "CEP" collides on "re*cep*ção".
  await page.getByRole("textbox", { name: "CEP", exact: true }).fill("01310-100");
  await page.getByLabel("Logradouro / Rua").fill("Avenida Paulista");
  await page.getByLabel("Número").fill("1000");
  await page.getByLabel("Bairro").fill("Bela Vista");
  await page.getByLabel("Cidade").fill("São Paulo");
  await selectRadixOption(page, "UF", "SP");
  await page.getByRole("checkbox", { name: /Ressonância Magnética/ }).check();
  // Index 1, not a named option: this test should not depend on which specific seeded
  // account happens to be eligible, only that at least one is (see
  // ListTechnicalManagerOptionsHandler) -- index 0 would be the placeholder in a native
  // <select>, but Radix's `Select` never renders the placeholder as a real item (it's
  // `SelectValue`'s own `placeholder` prop, shown only while nothing is chosen), so the
  // first real item is now index 0.
  await selectRadixOption(page, "Gestor técnico local", { index: 0 });
  await page.getByRole("button", { name: "Salvar Unidade" }).click();

  await page.waitForURL("/admin/units");
  const row = page.getByRole("row").filter({ hasText: cnes });
  await row.waitFor();

  // Read-only view: every control disabled.
  await row.getByRole("link", { name: "Ver detalhes" }).click();
  await page.waitForURL(/\/admin\/units\/[^/]+$/);
  await page.getByRole("heading", { name: "Detalhes da Unidade" }).waitFor();
  await expect(page.getByLabel("Nome da unidade")).toBeDisabled();
  await expectNoViolations(page);

  await page.getByRole("link", { name: "Editar unidade" }).click();
  await page.waitForURL(/\/admin\/units\/[^/]+\/edit$/);
  await page.getByRole("heading", { name: "Editar Unidade" }).waitFor();
  await expect(page.getByLabel("Nome da unidade")).toBeEnabled();
  await expectNoViolations(page);

  // Cleanup: retire the unit this test registered, so repeated runs don't accumulate rows
  // (and so the deactivation confirmation modal gets scanned too -- it's a dialog, which axe
  // only sees while actually open).
  await page.getByRole("link", { name: "Cancelar" }).click();
  await page.waitForURL("/admin/units");
  await page.getByRole("row").filter({ hasText: cnes }).getByRole("button", { name: "Desativar" }).click();
  const dialog = page.getByRole("dialog", { name: "Desativar unidade" });
  await dialog.waitFor();
  await expectNoViolations(page);
  await dialog.getByRole("button", { name: "Desativar" }).click();
  await expect(dialog).toBeHidden();
});

test("Admin clinics page: the registry listing, with filters applied", async ({ page }) => {
  await login(page, SUPERADMIN.email, SUPERADMIN.password);
  await page.getByRole("link", { name: "Clínicas" }).click();
  await page.waitForURL("/superadmin/clinics");
  await page.getByRole("heading", { name: "Gestão de Clínicas Cadastradas" }).waitFor();
  await expectNoViolations(page);

  // Same reasoning as the equipment/unit listings' own filtered-state scans: swaps the
  // table for a "nothing matches" note and updates the `aria-live` filter-summary region
  // axe doesn't see by default.
  await page.getByLabel("Buscar clínica").fill("nao-existe-nenhuma-clinica-assim");
  await page.getByText("Nenhuma clínica corresponde aos filtros aplicados.").waitFor();
  await expectNoViolations(page);
});

/**
 * Generates a CNPJ that passes `isValidCnpj`'s real mod-11 check-digit algorithm, mirroring
 * `apps/api/test/helpers.ts`'s own private `generateValidCnpj()` -- kept local here rather
 * than exported from `@crop/shared` for the same reason that one is private to the test
 * file it lives in: a random-CNPJ generator has no legitimate production use, only a test
 * fixture's. CNPJ is globally unique (`CreateTenantCommand`'s pre-check, backed by the
 * schema's own unique index), so a fixed literal would 409 on the second run.
 */
function generateValidCnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join("");
  const digits = base.split("").map(Number);
  const weightedMod11 = (values: number[], weights: number[]) => {
    const sum = values.reduce((total, value, index) => total + value * weights[index]!, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const firstCheck = weightedMod11(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondCheck = weightedMod11([...digits, firstCheck], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${firstCheck}${secondCheck}`;
}

test("Clinic form page: create, read-only view, and edit", async ({ page }) => {
  await login(page, SUPERADMIN.email, SUPERADMIN.password);
  await page.goto("/superadmin/clinics/new");

  // The create form: two sections plus the create-only note replacing section 03 (no
  // manager to assign yet -- see ClinicFormPage's own docstring). No status toggle, unlike
  // the equipment/unit create forms -- a clinic is always created active.
  await page.getByRole("heading", { name: "Cadastrar Nova Clínica" }).waitFor();
  await expectNoViolations(page);

  const cnpj = generateValidCnpj();
  const clinicName = `A11y Clinic ${Date.now()}`;
  await page.getByLabel("Nome da clínica").fill(clinicName);
  await page.getByLabel("CNPJ").fill(cnpj);
  await page.getByLabel("E-mail institucional").fill("contato@a11y-clinic.crop.health");
  await page.getByLabel("Telefone de contato").fill("(11) 3456-7890");
  // Same Playwright accessible-name quirk `UnitFormPage`'s own test already documents:
  // `getByLabel("CEP", { exact: true })` fails because the hidden required-asterisk span's
  // "*" is included in the raw <label> textContent this form's own `RequiredLabel` renders.
  await page.getByRole("textbox", { name: "CEP", exact: true }).fill("01310-100");
  await page.getByLabel("Rua / Logradouro").fill("Avenida Paulista");
  await page.getByLabel("Número").fill("1000");
  await page.getByLabel("Bairro").fill("Bela Vista");
  await page.getByLabel("Cidade").fill("São Paulo");
  await selectRadixOption(page, "UF", "SP");
  await page.getByRole("button", { name: "Salvar Clínica" }).click();

  await page.waitForURL("/superadmin/clinics");
  const row = page.getByRole("row").filter({ hasText: clinicName });
  await row.waitFor();

  // Read-only view: every control disabled, and the CNPJ renders as read-only formatted
  // text (no `cnpj` field on `UpdateTenantRequestSchema` at all -- see that schema's
  // docstring), unlike every other field which stays a plain (disabled) input.
  await row.getByRole("link", { name: "Ver detalhes" }).click();
  await page.waitForURL(/\/superadmin\/clinics\/[^/]+$/);
  await page.getByRole("heading", { name: "Detalhes da Clínica" }).waitFor();
  await expect(page.getByLabel("Nome da clínica")).toBeDisabled();
  await expectNoViolations(page);

  await page.getByRole("link", { name: "Editar clínica" }).click();
  await page.waitForURL(/\/superadmin\/clinics\/[^/]+\/edit$/);
  await page.getByRole("heading", { name: "Editar Clínica" }).waitFor();
  await expect(page.getByLabel("Nome da clínica")).toBeEnabled();
  // Section 03 now renders as a real manager picker (edit mode, unlike create) -- scanned
  // here rather than only in create, since it's a whole extra `<select>` create never shows.
  await expect(page.getByLabel("Gestor responsável")).toBeVisible();
  await expectNoViolations(page);

  // Cleanup: retire the clinic this test registered, so repeated runs don't accumulate rows
  // (and so the deactivation confirmation modal gets scanned too -- it's a dialog, which axe
  // only sees while actually open).
  await page.getByRole("link", { name: "Cancelar" }).click();
  await page.waitForURL("/superadmin/clinics");
  await page.getByRole("row").filter({ hasText: clinicName }).getByRole("button", { name: "Desativar" }).click();
  const dialog = page.getByRole("dialog", { name: "Desativar clínica" });
  await dialog.waitFor();
  await expectNoViolations(page);
  await dialog.getByRole("button", { name: "Desativar" }).click();
  await expect(dialog).toBeHidden();
});

test("Workstation page, then the exam cockpit and replay page", async ({ page }) => {
  // OPERATOR lands here directly now (see role-routes.ts), not on "/" -- same kind of
  // role-specific home as NURSING's "/enfermagem" below.
  await login(page, OPERATOR.email, OPERATOR.password, "/posto-de-trabalho");
  await page.getByRole("heading", { name: "Selecione seu Posto de Trabalho" }).waitFor();
  await expectNoViolations(page);

  // `operator@central` is contracted to two clinics (Alpha and Beta -- see the seed's own
  // agreement topology), so nothing here is auto-selected the way a genuinely single-clinic
  // operator's own dropdown would be (see WorkstationPage's `loadClinics`): a real choice
  // exists, and picking it is this step's whole point. Alpha is the one with real equipment
  // (Unidade Jardins/MRI-01) this test needs.
  await selectRadixOption(page, "Clínica", "Clinica Alpha");
  await page.getByText("Acessando clínica...").waitFor({ state: "hidden" });

  // Alpha's operator has one unit with real equipment ("Unidade Jardins" / MRI-01) and one
  // with none (the migration-backfilled "Unidade Principal") -- picking the empty one is
  // exercised by the dedicated "Workstation page" test below; this flow needs the room that
  // actually has a scanner to reach ExamPage.
  await selectRadixOption(page, "Unidade de Atendimento", "Unidade Jardins");
  const roomSelect = page.getByLabel("Equipamento & Sala");
  await expect(roomSelect).toBeEnabled();
  // Index 0, not a named option: Radix never renders a disabled placeholder as a real item
  // (see UnitFormPage's own test comment on the same point), so the first real room is at
  // index 0 -- this test should not depend on which specific one it is, only that it exists.
  await selectRadixOption(page, "Equipamento & Sala", { index: 0 });
  await expectNoViolations(page);

  // Confirm now navigates straight to ExamPage (`?equipmentId=`), not the scoped dashboard
  // -- see WorkstationPage's own docstring on this destination change.
  await page.getByRole("button", { name: "Confirmar e Acessar Sala" }).click();
  await page.waitForURL(/\/exame\?.*equipmentId=/);

  // Depends on PiKvmHealthPoller having already confirmed the mock PiKVM is reachable and
  // flipped equipment to ONLINE (happens shortly after `make demo` starts) -- generous
  // timeout, not a fixed sleep, since exactly how long that takes depends on when the demo
  // stack itself came up relative to this test run. Accepts either the "start the next
  // exam" prompt (no active session yet) or the cockpit already showing "Finalizar Exame"
  // (one left open by an earlier run of this same spec, e.g. after a prior failure before
  // its own cleanup step ran) -- either way, this test drives it to the same cockpit view.
  const startButton = page.getByRole("button", { name: "Iniciar Exame" });
  // Scoped to the header: the right column's own bottom action button reads "Finalizar
  // Exame & Liberar Sala" now (see ExamPage's own docstring on why the two never share an
  // accessible name), but this locator predates that split and is cheapest left header-
  // scoped rather than re-derived.
  const endButton = page.getByRole("banner").getByRole("button", { name: "Finalizar Exame" });
  await expect(startButton.or(endButton)).toBeVisible({ timeout: 30_000 });
  if (await startButton.isVisible()) {
    await expectNoViolations(page);
    await startButton.click();
    await endButton.waitFor();
  }
  await expectNoViolations(page);

  // The room's own exam-support chat: send a message over REST, scanned once the live
  // socket broadcast (EXAM_MESSAGE_CREATED, joined via JOIN_EQUIPMENT_CHAT) round-trips it
  // back into the transcript -- see ExamChat/ExamPage's own docstring. Push-to-talk
  // ("Falar com Paciente") no longer exists on this page at all -- the intercom feature was
  // removed outright, not merely hidden, so there is nothing left here to scan for it.
  // Uniquified with a timestamp: this suite runs against the persistent demo stack (see this
  // file's own top docstring), so a fixed literal string would accumulate one duplicate row
  // per prior run's success, eventually making the "did my own message arrive" assertion
  // below ambiguous between today's real send and yesterday's leftover.
  const examChatText = `Paciente posicionado, iniciando aquisição. ${Date.now()}`;
  await page.getByLabel("Mensagem").fill(examChatText);
  // `exact: true`: without it, Playwright's substring accessible-name match also picks up
  // the print-text form's own "Enviar ao Equipamento" button below.
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  // Scoped to the transcript's own `role="log"` region, not a bare `getByText`: the
  // composer's disabled textarea can transiently still hold the same text mid-request (the
  // live broadcast reaching a *second* socket is near-instant on localhost; clearing the
  // sender's own textarea waits on that same REST call's response), which would otherwise
  // make this locator ambiguous between the rendered message bubble and the textarea.
  await page.getByRole("log").getByText(examChatText).waitFor();
  await expectNoViolations(page);

  // The "Criar Atalho" quick-reply dialog -- the one remaining dialog on this page now that
  // the patient-info panel is inline, not a modal (see below) -- closed without submitting
  // so no MessageShortcut is created against the persistent demo stack.
  // "Criar Atalho", not "+ Criar Atalho": the leading "+" is now a lucide `Plus` icon, not a
  // literal character, matching every other "add" button's own accessible-name convention in
  // this app since the shadcn migration (e.g. NursingPage's "Novo Exame").
  await page.getByRole("button", { name: "Criar Atalho" }).click();
  const shortcutDialog = page.getByRole("dialog", { name: "Novo atalho de resposta rápida" });
  await shortcutDialog.waitFor();
  await expectNoViolations(page);
  await shortcutDialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(shortcutDialog).toBeHidden();

  // The active-patient panel -- inline in the right column now, not a modal (see this
  // page's own docstring on why): it auto-selects the room's current patient on load, so it
  // is already showing whatever this session started with. Selecting a different card from
  // the top queue rail re-renders it in place, with nothing to open or close -- scanned both
  // before and after that reselection. Only rendered if the room's queue actually has an
  // entry today; a queue this seed/prior-run state left empty simply has nothing to select,
  // same "scan whatever state actually exists" reasoning the Nursing page test below already
  // applies to its own queue-card-driven panels. Scoped to the top rail's own `<ul>`
  // (implicit `role="list"`) -- the only list this page renders once a session is active --
  // rather than a class name, now that QueueStrip's cards are plain Tailwind-styled buttons
  // with no distinguishing class of their own.
  const patientCards = page.getByRole("list").getByRole("button");
  if ((await patientCards.count()) > 0) {
    await page.getByText("Ficha do Paciente Ativo").waitFor();
    await expectNoViolations(page);
    await patientCards.first().click();
    await expectNoViolations(page);
  }

  await page.getByRole("button", { name: "Ver replay" }).click();
  await page.waitForURL(/\/sessions\/[^/]+\/replay$/);
  await page.getByRole("heading", { name: /session replay$/ }).waitFor();
  await expectNoViolations(page);

  // Cleanup: free the equipment for any later run of this same spec (or a manual demo
  // session) rather than leaving a session open indefinitely.
  await page.goBack();
  await page.getByRole("banner").getByRole("button", { name: "Finalizar Exame" }).click();
});

test("Workstation page: unit with no equipment, and the exam cockpit's start-exam prompt", async ({ page }) => {
  // A throwaway unit with zero equipment, created directly via the API as ADMIN -- the
  // migration-backfilled "Unidade Principal" this test used to rely on only ever existed for
  // clinic tenants that predated that migration; a freshly reset database's seed creates
  // Alpha with only "Unidade Jardins" (which has real equipment), so there is no longer a
  // no-equipment unit to select without creating one. Done via `page.request` rather than
  // the UI form (see "Unit form page" above for that flow) since creating this fixture isn't
  // itself what this test is about.
  await login(page, ADMIN.email, ADMIN.password);
  const adminToken = await page.evaluate(() => localStorage.getItem("crop.accessToken"));
  const me = await page.request
    .get("http://localhost:3000/auth/me", { headers: { Authorization: `Bearer ${adminToken}` } })
    .then((r) => r.json());
  const emptyUnitName = `A11y Empty Unit ${Date.now()}`;
  const emptyUnitRes = await page.request.post("http://localhost:3000/units", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: emptyUnitName,
      establishmentType: "LABORATORY",
      technicalManagerId: me.id,
      declaredModalities: ["CT"],
      zipCode: "01310-100",
      street: "Rua Teste",
      number: "1",
      district: "Centro",
      city: "São Paulo",
      state: "SP",
    },
  });
  expect(emptyUnitRes.ok()).toBeTruthy();
  const emptyUnitId = (await emptyUnitRes.json()).id;

  // Creating a unit does not, by itself, grant Operadora Central access to it -- agreement
  // scope is deny-by-default (see OperatorAgreement's own docstring), and Central's contract
  // with Alpha is scoped to "Unidade Jardins" alone (see the seed's own topology comment).
  // Extend that agreement's scope to include this new unit too, the same
  // "send the complete desired state" call AgreementsPage's own scope editor makes.
  const agreements = await page.request
    .get("http://localhost:3000/agreements", { headers: { Authorization: `Bearer ${adminToken}` } })
    .then((r) => r.json());
  const centralAgreement = agreements.find((a: { operatorName: string }) => a.operatorName === "Operadora Central");
  const currentUnitIds = centralAgreement.scopes.filter((s: { unitId: string | null }) => s.unitId).map((s: { unitId: string }) => s.unitId);
  const currentEquipmentIds = centralAgreement.scopes
    .filter((s: { equipmentId: string | null }) => s.equipmentId)
    .map((s: { equipmentId: string }) => s.equipmentId);
  const scopeRes = await page.request.put(`http://localhost:3000/agreements/${centralAgreement.id}/scope`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { unitIds: [...currentUnitIds, emptyUnitId], equipmentIds: currentEquipmentIds },
  });
  expect(scopeRes.ok()).toBeTruthy();
  await page.evaluate(() => localStorage.clear());

  await login(page, OPERATOR.email, OPERATOR.password, "/posto-de-trabalho");

  // The room dropdown is disabled with an explanatory placeholder until a unit is chosen.
  await expect(page.getByLabel("Equipamento & Sala")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Confirmar e Acessar Sala" })).toBeDisabled();

  // Same real two-clinic choice as the previous test -- see its own comment.
  await selectRadixOption(page, "Clínica", "Clinica Alpha");
  await page.getByText("Acessando clínica...").waitFor({ state: "hidden" });

  // The unit just created above has no equipment -- the empty state replaces the room
  // `<select>` entirely rather than rendering it with zero options.
  await selectRadixOption(page, "Unidade de Atendimento", emptyUnitName);
  await page.getByText("Esta unidade não possui equipamentos cadastrados.").waitFor();
  await expectNoViolations(page);

  // Switching to the unit that does have equipment enables the room picker; selecting a
  // room shows the real status badge + queue count and enables Confirm.
  await selectRadixOption(page, "Unidade de Atendimento", "Unidade Jardins");
  const roomSelect = page.getByLabel("Equipamento & Sala");
  await expect(roomSelect).toBeEnabled();
  await selectRadixOption(page, "Equipamento & Sala", { index: 0 });
  await expect(page.getByRole("button", { name: "Confirmar e Acessar Sala" })).toBeEnabled();
  await expectNoViolations(page);

  await page.getByRole("button", { name: "Confirmar e Acessar Sala" }).click();
  await page.waitForURL(/\/exame\?.*equipmentId=/);
  // Either ExamPage's own "start the next exam" prompt, or (if the previous test's cleanup
  // hasn't landed yet in a parallel run) the cockpit already showing "Finalizar Exame" --
  // same acceptance as the previous test's own wait, since this is the same room.
  await expect(
    page.getByRole("button", { name: "Iniciar Exame" }).or(page.getByRole("banner").getByRole("button", { name: "Finalizar Exame" }))
  ).toBeVisible({
    timeout: 30_000,
  });
  await expectNoViolations(page);
});

test("Nursing page", async ({ page }) => {
  // NURSING lands here directly (see role-routes.ts), not on "/" -- unlike every other
  // account this file logs in as.
  await login(page, NURSE.email, NURSE.password, "/enfermagem");
  await page.getByRole("heading", { name: "Enfermagem" }).waitFor();

  // Scanned as-is, whatever the seeded queue's current state happens to be (WAITING/
  // IN_PROGRESS/empty, with or without an active session locking the room) -- deliberately
  // not driven through a quick-action click first: unlike a session start/end (which
  // self-cleans) or a maintenance toggle (which this file already clears elsewhere), there
  // is no "un-position"/"un-release" action to undo a real click here, and this tier runs
  // against the persistent demo stack's own seeded data (see this file's own top docstring),
  // not a disposable test database. The rendered markup -- the horizontal queue-card strip,
  // its status chips, the room-context header, and the "Ações Rápidas" panel in whichever
  // state it's actually in -- is what needs to be axe-clean either way.
  await expectNoViolations(page);

  // The exam-data overlay ("Dados do Exame" / "Aguardando Posicionamento") -- shown
  // automatically over the details card whenever the room's current patient still has
  // preparationStatus NOT_STARTED (see isAwaitingPositioning in queue-display.ts). The
  // seed leaves every Alpha queue entry at NOT_STARTED (no positioning action has ever
  // run against this persistent demo stack's fixtures unless a previous test run's own
  // quick-action click advanced it -- see the "not driven through a quick-action click
  // first" reasoning above), so this is normally present; guarded the same way as every
  // other queue-state-dependent block in this test, since a prior run could have moved it
  // past NOT_STARTED. Scanned already-open by the plain `expectNoViolations` above -- this
  // additionally exercises the collapse/expand toggle, a distinct rendered state neither
  // of those calls has seen yet.
  const overlay = page.getByRole("region", { name: "Dados do Exame" });
  if (await overlay.isVisible().catch(() => false)) {
    const collapseButton = page.getByRole("button", { name: "Recolher" });
    await collapseButton.click();
    await expect(page.getByRole("button", { name: "Expandir" })).toHaveAttribute("aria-expanded", "false");
    await expectNoViolations(page);

    await page.getByRole("button", { name: "Expandir" }).click();
    await expect(page.getByRole("button", { name: "Recolher" })).toHaveAttribute("aria-expanded", "true");
    await expectNoViolations(page);
  }

  // Mid-reorder: clicking a "←"/"→" button only mutates the client-side draft (POST
  // /queue/reorder is a separate, never-clicked "Confirmar Nova Sequência" button) -- so
  // unlike a real quick-action click, this is naturally undone by the next page load and
  // needs no cleanup step against the persistent demo stack. Scans the reorder banner
  // (amber, role="status") that only exists once the draft has actually diverged. Filtered
  // to an *enabled* one -- the first card's "Antecipar" and the last card's "Postergar" are
  // legitimately disabled (nothing to swap with past either end), the same reasoning the
  // "Session page" test above already applies to its own start/rejoin button.
  const moveButtons = page.locator("button:not([disabled])").filter({ hasText: /^[←→]$/ });
  if ((await moveButtons.count()) > 0) {
    await moveButtons.first().click();
    await page.getByRole("button", { name: "Confirmar Nova Sequência" }).waitFor();
    await expectNoViolations(page);
  }

  // Selecting a patient card opens the exam-details panel (read-only by default) *and* the
  // per-exam timeline in the right column -- both read-only against the API, so like the
  // reorder draft above this leaves nothing to clean up. Also collapses the exam-data
  // overlay if it was open (see selectEntryForEditing's own comment on why): without that,
  // the overlay scanned above could still be covering the very "Habilitar Edição" button
  // this waits on next. Scoped to the queue rail's own `<ul>` (implicit `role="list"`, the
  // first of two on this page -- the second is the per-exam timeline in the right column,
  // which renders later in the DOM) rather than a class name, now that queue cards are plain
  // Tailwind-styled buttons with no distinguishing class of their own.
  const patientCards = page.getByRole("list").first().getByRole("button");
  if ((await patientCards.count()) > 0) {
    await patientCards.first().click();
    // Not `getByLabel("Tipo do Exame")`: that label only exists once editing is enabled
    // (see NursingPage's `SummaryField` vs. its edit-mode `<Label htmlFor="details-exam-
    // description">`) -- the read-only summary this click reveals shows the same value as
    // plain text under a caption, with no `<label>` association at all. Waiting on
    // "Habilitar Edição" itself is what actually confirms the read-only panel rendered.
    await page.getByRole("button", { name: "Habilitar Edição" }).waitFor();
    await expectNoViolations(page);

    // "Habilitar Edição" unlocks the same fields in place -- a different rendered state
    // (enabled inputs, the "Em Edição" badge, a live Save button) worth its own scan, and
    // still no write: nothing clicks "Salvar Alterações deste Paciente".
    await page.getByRole("button", { name: "Habilitar Edição" }).click();
    await page.getByText("Em Edição").waitFor();
    await expectNoViolations(page);
  }

  // The "Novo Exame" modal -- the second dialog anywhere in this app (see Modal.tsx), so
  // axe has to see it while actually open. Closed again without submitting, so no queue
  // entry is created against the persistent demo stack.
  await page.getByRole("button", { name: "Novo Exame" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo Exame" });
  await dialog.waitFor();
  await expectNoViolations(page);
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toBeHidden();

  // The room's own exam-support chat (`ExamChat`, shared with `ExamPage`) -- nursing can
  // now send and receive it too, over the same `equipment:<id>` socket room and the same
  // `POST /chat/messages` REST write, joined via `JOIN_EQUIPMENT_CHAT` when this page's own
  // socket connects. Scanned once the message actually round-trips back into the transcript
  // via the live broadcast, the same pattern the exam cockpit's own chat test already uses.
  const nursingChatText = `Turno iniciado ${Date.now()}`;
  await page.getByLabel("Mensagem").fill(nursingChatText);
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  await page.getByRole("log").getByText(nursingChatText).waitFor();
  await expectNoViolations(page);
});
