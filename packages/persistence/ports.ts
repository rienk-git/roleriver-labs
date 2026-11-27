/** Tenant identities must be authenticated and authorized by the caller. */
export interface Vacancy {
  id: string;
  title: string;
  organization: string;
  createdAt: string;
  version: number;
}
export interface NewVacancy {
  id: string;
  title: string;
  organization: string;
  createdAt: string;
  source: string;
  externalId: string;
  /** Optional sanitized HTTPS URL; not permission to fetch. */
  sourceUrl?: string;
}
export interface SourceReference {
  source: string;
  /** Private runtime metadata; do not log or publish. */
  externalId: string;
  /** Hash used as a deduplication key; not anonymization. */
  sourceHash: string;
  /** Sanitized HTTPS URL, when supplied; does not authorize automated access. */
  url?: string;
}
export interface VacancyStore {
  create(
    tenant: string,
    input: NewVacancy,
  ): Promise<{ status: "created" | "duplicate" | "conflict" }>;
  get(tenant: string, vacancyId: string): Promise<Vacancy | null>;
  getVersion(
    tenant: string,
    vacancyId: string,
    version: number,
  ): Promise<Vacancy | null>;
  findBySource(
    tenant: string,
    source: string,
    externalId: string,
  ): Promise<Vacancy | null>;
  attachSource(
    tenant: string,
    vacancyId: string,
    source: string,
    externalId: string,
    options?: { url?: string },
  ): Promise<{ status: "attached" | "duplicate" | "conflict" | "not_found" }>;
  listSources(
    tenant: string,
    vacancyId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: SourceReference[]; cursor: string | null }>;
  replace(
    tenant: string,
    vacancyId: string,
    expectedVersion: number,
    content: { title: string; organization: string },
  ): Promise<{ status: "updated" | "conflict" }>;
  listRecent(
    tenant: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: Vacancy[]; cursor: string | null }>;
}
export interface ObjectMetadata {
  size: number;
  sha256: string;
}
export interface ObjectStore {
  put(
    tenantId: string,
    objectId: string,
    content: Uint8Array,
  ): Promise<ObjectMetadata>;
  get(
    tenantId: string,
    objectId: string,
    expected?: ObjectMetadata,
  ): Promise<Uint8Array | null>;
  delete(tenantId: string, objectId: string): Promise<void>;
}
