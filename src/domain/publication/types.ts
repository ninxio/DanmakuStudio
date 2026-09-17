import type { LibraryProfile } from "../project/discovery";
export interface PublicationFile {
  readonly fileName: string;
  readonly content: string;
  readonly targetFileName?: string;
  readonly durationMs?: number | null;
}
export interface PublicationDelivery {
  readonly libraryProfile?: LibraryProfile;
  readonly projectId: string;
  readonly projectUpdatedAt: string;
  readonly projectName: string;
  readonly kind: "xml" | "family" | "projection";
  readonly createdAt: string;
  readonly files: readonly PublicationFile[];
}
