import type { UserRole } from "@crop/shared";

export class PreviewInvitationQuery {
  constructor(public readonly token: string) {}
}

export interface PreviewInvitationResult {
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  professionalRegistration: string | null;
  expiresAt: string;
}
