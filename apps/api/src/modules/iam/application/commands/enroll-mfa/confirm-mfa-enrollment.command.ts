export class ConfirmMfaEnrollmentCommand {
  constructor(
    public readonly enrollmentToken: string,
    public readonly code: string
  ) {}
}
