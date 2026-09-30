import { EstablishmentType, ExamModality } from "@crop/shared";

export interface UnitProps {
  id: string;
  clinicTenantId: string;
  name: string;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Nullable for rows that predate the unit-registration screen -- see the unit_registry
  // migration's own note on why they were not backfilled with invented values.
  // `CreateUnitRequestSchema` requires all of these for a new row, so the null set here
  // only ever shrinks.
  establishmentType: EstablishmentType | null;
  technicalManagerId: string | null;
  declaredModalities: ExamModality[];
  cnesCode: string | null;
  phone: string | null;
  technicalEmail: string | null;
  zipCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
}

/** A clinic's own sub-site -- see schema.prisma's own comment on the `Unit` model. */
export class Unit {
  constructor(private readonly props: UnitProps) {}

  get id(): string {
    return this.props.id;
  }

  get clinicTenantId(): string {
    return this.props.clinicTenantId;
  }

  get name(): string {
    return this.props.name;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get deactivatedAt(): Date | null {
    return this.props.deactivatedAt;
  }

  get establishmentType(): EstablishmentType | null {
    return this.props.establishmentType;
  }

  get technicalManagerId(): string | null {
    return this.props.technicalManagerId;
  }

  get declaredModalities(): ExamModality[] {
    return this.props.declaredModalities;
  }

  get cnesCode(): string | null {
    return this.props.cnesCode;
  }

  get phone(): string | null {
    return this.props.phone;
  }

  get technicalEmail(): string | null {
    return this.props.technicalEmail;
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

  isDeactivated(): boolean {
    return this.props.deactivatedAt !== null;
  }

  belongsToClinic(clinicTenantId: string): boolean {
    return this.props.clinicTenantId === clinicTenantId;
  }
}
