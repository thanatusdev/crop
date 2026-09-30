import { isMatrizCnpj, cnpjRoot as computeCnpjRoot, TenantType } from "@crop/shared";

export interface TenantProps {
  id: string;
  name: string;
  type: TenantType;
  createdAt: Date;
  updatedAt: Date;
  deactivatedAt: Date | null;
  // Nullable for rows that predate this feature, and for every PLATFORM/OPERATOR_PROVIDER
  // tenant (neither ever has a CNPJ) -- see the clinic_registry migration's own note.
  // `CreateTenantRequestSchema` requires all of these for a new CLINIC, so the null set only
  // ever shrinks for that type.
  cnpj: string | null;
  institutionalEmail: string | null;
  phone: string | null;
  zipCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  responsibleManagerId: string | null;
}

/**
 * A thin domain wrapper around the persisted tenant row -- same shape and reasoning as
 * `User`: named, testable predicates instead of scattering `tenant.deactivatedAt !== null`
 * checks across handlers.
 */
export class Tenant {
  constructor(private readonly props: TenantProps) {}

  get id(): string {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get type(): TenantType {
    return this.props.type;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get cnpj(): string | null {
    return this.props.cnpj;
  }

  get institutionalEmail(): string | null {
    return this.props.institutionalEmail;
  }

  get phone(): string | null {
    return this.props.phone;
  }

  get zipCode(): string | null {
    return this.props.zipCode;
  }

  get street(): string | null {
    return this.props.street;
  }

  get number(): string | null {
    return this.props.number;
  }

  get complement(): string | null {
    return this.props.complement;
  }

  get district(): string | null {
    return this.props.district;
  }

  get city(): string | null {
    return this.props.city;
  }

  get state(): string | null {
    return this.props.state;
  }

  get responsibleManagerId(): string | null {
    return this.props.responsibleManagerId;
  }

  // Nullable timestamp, not a boolean column -- same reasoning as User.lockedAt: doubles as
  // a "when" for anyone reviewing why a tenant's users suddenly can't log in.
  isDeactivated(): boolean {
    return this.props.deactivatedAt !== null;
  }

  /** `null` when this tenant has no CNPJ at all (PLATFORM/OPERATOR_PROVIDER, or a CLINIC
   * predating this feature) -- there is no branch role to derive from a CNPJ that doesn't
   * exist. See `cnpj.ts`'s own docstring on the derivation itself. */
  isMatriz(): boolean | null {
    return this.props.cnpj ? isMatrizCnpj(this.props.cnpj) : null;
  }

  /** The 8-digit root shared by every branch of this same legal entity, or `null`. */
  get cnpjRoot(): string | null {
    return this.props.cnpj ? computeCnpjRoot(this.props.cnpj) : null;
  }
}
