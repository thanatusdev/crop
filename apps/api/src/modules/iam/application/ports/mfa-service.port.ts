export const MFA_SERVICE = Symbol("MFA_SERVICE");

export interface MfaSecretAndUri {
  secret: string;
  provisioningUri: string;
}

export interface MfaServicePort {
  generateSecret(accountLabel: string): MfaSecretAndUri;
  provisioningUriFor(secret: string, accountLabel: string): string;
  verifyCode(secret: string, code: string): boolean;
}
