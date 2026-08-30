import { ArgumentMetadata, BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * We already define every wire contract as a Zod schema in @crop/shared, shared verbatim with
 * the frontend. Using class-validator DTOs on top would mean maintaining the same validation
 * rules twice in two different systems -- this pipe lets controllers validate directly
 * against the Zod schema instead.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues.map((i) => ({ path: i.path, message: i.message })));
    }
    return result.data;
  }
}
