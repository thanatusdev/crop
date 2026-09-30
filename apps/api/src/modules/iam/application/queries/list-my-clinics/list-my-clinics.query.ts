export class ListMyClinicsQuery {
  constructor(
    public readonly userId: string,
    /**
     * The tenant the caller *belongs to* (`AccessTokenClaims.homeTenantId`), which is what
     * determines reachability: their own clinic if they are clinic-side, or the operating company
     * whose contracts to look up if they are not.
     */
    public readonly homeTenantId: string,
    /**
     * The tenant the caller is *currently acting in* (`AccessTokenClaims.tenantId`), used only to
     * mark one entry `active: true`.
     *
     * Separate from `homeTenantId` because for a contracted operator these are different values,
     * and conflating them made the switcher wrong in a visible way: an operator who had switched
     * into a clinic saw no entry highlighted at all, because the list was being compared against
     * their operating company's id -- which is not a clinic and therefore never in the list.
     */
    public readonly activeTenantId: string
  ) {}
}
