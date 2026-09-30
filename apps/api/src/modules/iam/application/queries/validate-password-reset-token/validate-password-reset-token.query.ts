export class ValidatePasswordResetTokenQuery {
  constructor(public readonly token: string) {}
}

export interface ValidatePasswordResetTokenResult {
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  professionalRegistration: string | null;
  expiresAt: string;
}
