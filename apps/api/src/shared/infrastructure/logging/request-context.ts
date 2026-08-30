import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Makes the current request's correlation id available to any code running within its
 * async call chain -- most importantly, the structured logger (see pino-logger.service.ts),
 * which stamps every log line with it without every call site needing to thread it through
 * as an explicit parameter. Set once per request by RequestIdMiddleware.
 */
export const requestContext = {
  run<T>(context: RequestContext, fn: () => T): T {
    return storage.run(context, fn);
  },
  getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
};
