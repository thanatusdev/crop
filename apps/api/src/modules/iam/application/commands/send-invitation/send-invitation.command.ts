export class SendInvitationCommand {
  constructor(
    public readonly userId: string,
    public readonly actingAdminId: string | null,
    public readonly actingAdminTenantId: string | null,
    // Only differs in which AuditAction it records (USER_INVITED vs USER_INVITE_RESENT) --
    // see SendInvitationHandler. Defaults to the initial-invite case, since that's what
    // RegisterUserCommand's own caller (UsersController.create) always means.
    public readonly isResend: boolean = false
  ) {}
}
