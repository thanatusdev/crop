import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * The handful of metrics that actually matter for this platform's core claims -- sub-200ms
 * input latency and a reliable audit pipeline -- not a metric for every conceivable thing.
 * Each histogram's buckets are chosen around the specific budget documented in
 * docs/architecture.md, not prom-client's generic defaults, so a look at `/metrics` (or a
 * Grafana panel built from it) directly answers "are we inside budget?" rather than needing
 * a follow-up query to rebucket the data.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Every HID event accepted by the gateway, labelled by type -- the input volume this platform actually handles. */
  readonly hidInputEventsTotal = new Counter({
    name: "crop_hid_input_events_total",
    help: "Total HID input events accepted and forwarded to a PiKVM device",
    labelNames: ["event_type"],
  });

  /** Time from ProcessHidInputHandler receiving an event to it being handed to the PiKVM
   * WebSocket send call -- this platform's own processing overhead, not the full
   * browser-to-device round trip (the client-side latency HUD measures that separately). At
   * up to 60 events/sec this needs to be a small fraction of the 200ms budget. */
  readonly hidForwardDurationSeconds = new Histogram({
    name: "crop_hid_forward_duration_seconds",
    help: "Time to forward an accepted HID input event to the PiKVM device",
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  });

  readonly sessionsActive = new Gauge({
    name: "crop_sessions_active",
    help: "Currently active remote-operation sessions",
  });

  /** How long draining the Redis input buffer into Postgres takes -- see AuditFlushScheduler.
   * Must stay well under AUDIT_FLUSH_INTERVAL_MS or the buffer starts growing unboundedly. */
  readonly auditFlushDurationSeconds = new Histogram({
    name: "crop_audit_flush_duration_seconds",
    help: "Duration of one audit buffer flush cycle",
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  });

  readonly auditFlushBatchSize = new Histogram({
    name: "crop_audit_flush_batch_sessions",
    help: "Number of sessions with buffered input flushed in one cycle",
    buckets: [0, 1, 5, 10, 25, 50, 100],
  });

  readonly snapshotCaptureDurationSeconds = new Histogram({
    name: "crop_snapshot_capture_duration_seconds",
    help: "Duration of one session snapshot capture (PiKVM fetch + disk write + DB insert)",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

  /** Labelled by equipment, not a global counter -- one flaky device should be visible as
   * one noisy time series, not hidden inside an aggregate that looks fine on average. */
  readonly pikvmConnectionErrorsTotal = new Counter({
    name: "crop_pikvm_connection_errors_total",
    help: "PiKVM HID/media connection errors observed",
    labelNames: ["equipment_id"],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    // Registered individually, not via an array literal: TypeScript infers an array's
    // element type from its first member, and prom-client's `Counter<"event_type">` and
    // `Counter<"equipment_id">` are then seen as incompatible types for the same array.
    this.registry.registerMetric(this.hidInputEventsTotal);
    this.registry.registerMetric(this.hidForwardDurationSeconds);
    this.registry.registerMetric(this.sessionsActive);
    this.registry.registerMetric(this.auditFlushDurationSeconds);
    this.registry.registerMetric(this.auditFlushBatchSize);
    this.registry.registerMetric(this.snapshotCaptureDurationSeconds);
    this.registry.registerMetric(this.pikvmConnectionErrorsTotal);
  }
}
