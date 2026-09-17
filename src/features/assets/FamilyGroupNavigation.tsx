import { useState } from "react";
import { TextButton } from "../../components/TextButton";

/** Bounded workspace navigation keeps large imports from pushing editing below the fold. */
export function FamilyGroupNavigation({
  groups,
  activeKey,
  counts,
  onSelect
}: {
  groups: Array<[string, string]>;
  activeKey: string | undefined;
  counts: ReadonlyMap<string, number>;
  onSelect: (key: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const filtered = groups.filter(([, label]) =>
    label.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim())
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 8, currentPage * 8 + 8);
  return (
    <div className="family-navigation">
      {groups.length > 8 && (
        <div className="family-navigation-tools">
          <input
            type="search"
            aria-label="查找输出分集"
            placeholder="查找集号或输出名称"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
          <TextButton
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            aria-label="上一页分集"
          >
            上一页
          </TextButton>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <TextButton
            disabled={currentPage + 1 === pages}
            onClick={() => setPage(currentPage + 1)}
            aria-label="下一页分集"
          >
            下一页
          </TextButton>
        </div>
      )}
      <div className="family-group-navigation" role="group" aria-label="输出分集">
        {visible.map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={key === activeKey}
            onClick={() => onSelect(key)}
          >
            {label}
            <span>{counts.get(key) ?? 0} 段</span>
          </button>
        ))}
        {!visible.length && <p>没有找到对应输出，试试其他集号。</p>}
      </div>
    </div>
  );
}
