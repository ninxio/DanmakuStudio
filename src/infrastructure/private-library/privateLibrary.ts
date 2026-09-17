import { invoke, isTauri } from "@tauri-apps/api/core";

export interface PrivateLibraryStatus {
  configured: boolean;
  baseUrl: string;
  hasReadToken: boolean;
}
export interface PrivateLibraryConnection {
  baseUrl: string;
  publishToken: string;
  readToken: string;
}
export interface PublicationMetadata {
  workKey: string;
  editionKey: string;
  sourceKey?: string;
  sourceLabel?: string;
  expectedMetadataVersion?: number | null;
  title: string;
  aliases: string[];
  year: number | null;
  kind: "tv" | "movie";
  edition: string;
  season: number;
  episode: number;
  label: string;
  durationMs: number | null;
  fileNames: string[];
  allowAutoMatch: boolean;
}
export interface PublicationResult {
  episodeId: number;
  animeId: number;
  revision: string;
  commentCount: number;
  metadataVersion?: number | null;
}
export interface PublicationBaseline {
  expectedRevision: string | null;
  connectionScope: string;
  identity: string;
}
export async function preparePrivateLibraryPublication(
  metadata: PublicationMetadata
): Promise<PublicationBaseline> {
  desktop();
  return invoke("prepare_private_library_publication", { metadata });
}
export interface CanonicalMetadata {
  sourceKey: string;
  workKey: string;
  editionKey: string;
  title: string;
  aliases: string[];
  year: number | null;
  kind: "tv" | "movie";
  edition: string;
  sourceLabel: string;
}
export interface MetadataState {
  metadataVersion: number;
  canonicalMetadata: CanonicalMetadata;
}
export async function getPrivateLibraryMetadata(
  identity: Pick<
    PublicationMetadata,
    "workKey" | "editionKey" | "sourceKey" | "season" | "episode"
  >
): Promise<MetadataState | null> {
  desktop();
  return invoke("get_private_library_metadata", { identity });
}
function desktop(): void {
  if (!isTauri()) throw new Error("私人库连接和发布需要在 Windows 桌面版 Studio 中使用。");
}
export async function privateLibraryStatus(): Promise<PrivateLibraryStatus> {
  if (!isTauri()) return { configured: false, baseUrl: "", hasReadToken: false };
  return invoke("get_private_library_status");
}
export async function configurePrivateLibrary(
  request: PrivateLibraryConnection
): Promise<PrivateLibraryStatus> {
  desktop();
  return invoke("configure_private_library", { request });
}
export async function testPrivateLibrary(): Promise<{
  episodeCount: number;
  currentEpisodeCount?: number;
  pendingEpisodeCount?: number;
  visibleEpisodeCount?: number;
}> {
  desktop();
  return invoke("test_private_library");
}
export async function clearPrivateLibrary(): Promise<void> {
  desktop();
  return invoke("clear_private_library");
}
export async function privateLibraryPlayerUrl(): Promise<string> {
  desktop();
  return invoke("get_private_library_player_url");
}
export async function publishPrivateLibraryXml(
  xml: string,
  metadata: PublicationMetadata,
  baseline?: PublicationBaseline
): Promise<PublicationResult> {
  desktop();
  return invoke("publish_private_library_xml", { request: { xml, metadata, baseline } });
}
export const privateLibraryError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
