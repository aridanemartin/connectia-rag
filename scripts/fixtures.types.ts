export interface FixtureInstitution {
  name: string;
  email: string;
  phone: string;
  address: string;
}

export interface FixtureSourcePage {
  heading: string;
  paragraphs: string[];
}

export interface FixtureSource {
  institution: FixtureInstitution;
  pages: FixtureSourcePage[];
}

export interface FixtureVersion {
  versionId: string;
  title: string;
  academicYear: string;
  source: string;
  file: string;
  idempotencyKey: string;
  activate: boolean;
  replaced?: boolean;
}

export interface FixtureDocument {
  documentId: string;
  topic: string;
  title: string;
  description: string;
  versions: FixtureVersion[];
}

export interface FixtureReplacementPrevious {
  versionId: string;
  title: string;
  academicYear: string;
  source: string;
  file: string;
  idempotencyKey: string;
  activate: false;
}

export interface FixtureReplacementCurrent {
  versionId: string;
  title: string;
  academicYear: string;
  source: string;
  file: string;
  idempotencyKey: string;
  activate: true;
}

export interface FixtureReplacement {
  topic: string;
  documentId: string;
  previous: FixtureReplacementPrevious;
  current: FixtureReplacementCurrent;
}

export interface FixtureConflictClaim {
  documentId: string;
  versionId: string;
  page: number;
  claim: string;
}

export interface FixtureConflict {
  id: string;
  subject: string;
  claims: [FixtureConflictClaim, FixtureConflictClaim];
}

export interface CorpusManifest {
  schema: string;
  producer: string;
  generatedAt: string;
  academicYear: string;
  institution: FixtureInstitution;
  documents: FixtureDocument[];
  replacement: FixtureReplacement;
  conflicts: FixtureConflict[];
}

export type EvaluationStatus = "found" | "not_found" | "ambiguous";

export interface EvaluationQuestion {
  id: string;
  question: string;
  expectedStatus: EvaluationStatus;
  expectedDocumentIds: string[];
  expectedPages: number[];
}

export interface EvaluationSet {
  schema: string;
  academicYear: string;
  questions: EvaluationQuestion[];
}

export interface GeneratedPdfInfo {
  file: string;
  bytes: number;
  sha256: string;
  pages: number;
}

export interface GenerationSummary {
  files: GeneratedPdfInfo[];
}

export interface SeedVersionResult {
  documentId: string;
  versionId: string;
  file: string;
  jobId: string;
  jobStatus: string;
  activated: boolean;
  activationState: string | null;
}

export interface SeedSummary {
  seededVersions: SeedVersionResult[];
}
