/** Candidates for "Gestor Responsável" when editing a clinic or an operadora -- which role
 * it looks for is derived from the tenant's own type (see
 * `ListResponsibleManagerOptionsHandler`), not a parameter here. */
export class ListResponsibleManagerOptionsQuery {
  constructor(public readonly tenantId: string) {}
}
