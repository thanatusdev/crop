import type { TenantType } from "@crop/shared";

/** `type` undefined lists every tenant of every type, same as before this filter existed --
 * see `TenantsController.list`'s own validation of the raw query string. */
export class ListTenantsQuery {
  constructor(public readonly type?: TenantType) {}
}
