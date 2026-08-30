import type { BufferedInputItem } from "../../ports/audit-buffer.port.js";

export class BufferInputEventCommand {
  constructor(
    public readonly sessionId: string,
    public readonly item: BufferedInputItem
  ) {}
}
