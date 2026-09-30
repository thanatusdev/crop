import { Inject, Injectable } from "@nestjs/common";
import type { TechnicalManagerSummary } from "./ports/unit-repository.port.js";
import { UNIT_REPOSITORY, type UnitRepositoryPort } from "./ports/unit-repository.port.js";
import { Unit } from "../domain/unit.entity.js";

/**
 * A unit plus the read-model data `UnitSchema` denormalizes onto it (`equipmentCount`,
 * `roomCount`, `technicalManager`) but that isn't part of the domain entity itself -- see
 * `UnitRepositoryPort.summarizeEquipment`/`summarizeTechnicalManagers`'s own docstrings for
 * why those live as batch lookups on the repository rather than as `Unit` properties.
 */
export interface EnrichedUnit {
  unit: Unit;
  equipmentCount: number;
  roomCount: number;
  technicalManager: TechnicalManagerSummary | null;
}

/**
 * Shared by every command/query handler that returns one or more units to a caller
 * (`CreateUnitHandler`, `UpdateUnitHandler`, `SetUnitDeactivatedHandler`, `GetUnitHandler`,
 * `ListUnitsByClinicHandler`, `ListAccessibleUnitsHandler`) so the enrichment logic -- and
 * its two batched repository calls -- exists in exactly one place rather than being
 * re-derived per handler. Batched even for a single unit (`enrichOne` delegates to
 * `enrichMany`) so there is only one code path to keep correct.
 */
@Injectable()
export class UnitEnrichmentService {
  constructor(@Inject(UNIT_REPOSITORY) private readonly units: UnitRepositoryPort) {}

  async enrichMany(unitList: Unit[]): Promise<EnrichedUnit[]> {
    if (unitList.length === 0) return [];

    const unitIds = unitList.map((unit) => unit.id);
    const managerIds = [...new Set(unitList.map((unit) => unit.technicalManagerId).filter((id): id is string => id !== null))];

    const [equipmentSummaries, managerSummaries] = await Promise.all([
      this.units.summarizeEquipment(unitIds),
      this.units.summarizeTechnicalManagers(managerIds),
    ]);

    return unitList.map((unit) => ({
      unit,
      equipmentCount: equipmentSummaries[unit.id]?.equipmentCount ?? 0,
      roomCount: equipmentSummaries[unit.id]?.roomCount ?? 0,
      technicalManager: unit.technicalManagerId ? managerSummaries[unit.technicalManagerId] ?? null : null,
    }));
  }

  async enrichOne(unit: Unit): Promise<EnrichedUnit> {
    const [enriched] = await this.enrichMany([unit]);
    return enriched!;
  }
}
