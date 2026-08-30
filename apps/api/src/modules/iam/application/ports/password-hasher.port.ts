export const PASSWORD_HASHER = Symbol("PASSWORD_HASHER");

export interface PasswordHasherPort {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
}
