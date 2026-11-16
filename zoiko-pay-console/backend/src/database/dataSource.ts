import type {
  ActivityEvent, Environment, LegalEntity, Merchant, Payment, Payout, SettlementBatch,
} from "../types/domain.js";
import { errors } from "../types/errors.js";
import { generateFixtures, LEGAL_ENTITIES, MERCHANTS, type FixtureDataset } from "./fixtures.js";

/**
 * Read model the console services depend on. Today the only implementation is
 * development fixtures; each method switches to a Go service API (gateway,
 * execution, finance, governance) once that API exists. Services never assume
 * which implementation is behind it.
 *
 * The console holds no payment or ledger logic: it does not create payments,
 * move funds or post journals. It only reads.
 */
export interface ConsoleDataSource {
  readonly source: "fixture";
  asOf(): string;
  legalEntities(): LegalEntity[];
  merchants(env: Environment): Merchant[];
  payments(env: Environment): Payment[];
  payouts(env: Environment): Payout[];
  settlementBatches(env: Environment): SettlementBatch[];
  activity(env: Environment): ActivityEvent[];
}

export class FixtureDataSource implements ConsoleDataSource {
  readonly source = "fixture" as const;
  private readonly data: FixtureDataset;

  constructor(now = Date.now()) {
    this.data = generateFixtures(now);
  }

  /** Fixtures exist for TEST only. LIVE must never fall back to them. */
  private test(env: Environment): void {
    if (env !== "TEST") throw errors.liveUnavailable();
  }

  asOf(): string {
    return this.data.generatedAt;
  }
  legalEntities(): LegalEntity[] {
    return LEGAL_ENTITIES;
  }
  merchants(env: Environment): Merchant[] {
    this.test(env);
    return MERCHANTS;
  }
  payments(env: Environment): Payment[] {
    this.test(env);
    return this.data.payments;
  }
  payouts(env: Environment): Payout[] {
    this.test(env);
    return this.data.payouts;
  }
  settlementBatches(env: Environment): SettlementBatch[] {
    this.test(env);
    return this.data.settlementBatches;
  }
  activity(env: Environment): ActivityEvent[] {
    this.test(env);
    return this.data.activity;
  }
}
