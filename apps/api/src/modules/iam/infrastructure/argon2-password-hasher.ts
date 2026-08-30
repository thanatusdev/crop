import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";
import type { PasswordHasherPort } from "../application/ports/password-hasher.port.js";

@Injectable()
export class Argon2PasswordHasher implements PasswordHasherPort {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, { type: argon2.argon2id });
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    return argon2.verify(hash, plaintext);
  }
}
