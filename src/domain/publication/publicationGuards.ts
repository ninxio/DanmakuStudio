import type { PublicationDelivery, PublicationFile } from "./types";
import { isAudioOnlyMedia } from "../project/mediaFormat";
export function hasVideoMatchingEvidence(file: PublicationFile): boolean {
  return !!file.targetFileName && !isAudioOnlyMedia(file.targetFileName) && !!file.durationMs;
}
export function explicitSeasonEpisode(
  fileName: string
): { season: number; episode: number } | null {
  const m = /(?:^|[^a-z\d])S(\d{1,3})E(\d{1,4})(?!\d)/i.exec(fileName);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}
export function publicationConflict(
  delivery: PublicationDelivery,
  details: { season: string; kind: "movie" | "tv" },
  rows: readonly { selected: boolean; episode: string }[]
): string | null {
  const selected = rows
    .map((row, index) => ({ row, file: delivery.files[index] }))
    .filter((x) => x.row.selected);
  const explicit = selected
    .map((x) => explicitSeasonEpisode(x.file.fileName))
    .filter((x) => x !== null);
  const seasons = new Set(explicit.map((x) => x.season));
  if (seasons.size > 1)
    return "所选成品包含多个明确季号，不能统一发布。请按季选择成品分批发布。";
  const season = details.kind === "movie" ? 0 : Number(details.season);
  if (explicit.some((x) => x.season !== season))
    return "文件的 SxxExx 季号与表单冲突，请核对季号或按季分批发布。";
  const profile = delivery.libraryProfile;
  if (profile?.season != null && selected.length && profile.season !== season)
    return "成品快照的作品资料季号与表单冲突，请核对项目资料并重新导出；旧草稿和基线保留。";
  if (profile?.kind && profile.kind !== details.kind)
    return "成品快照的作品类型与表单冲突，请核对资料后重新导出。";
  const numbers = selected
    .map((x) => Number(x.row.episode))
    .filter((x) => Number.isInteger(x) && x > 0);
  if (new Set(numbers).size !== numbers.length)
    return "所选成品的最终发布身份重复（同作品、来源、版本、季、集），请分批或修正集数。";
  return null;
}
