import { useEffect, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  getProjectStorageLocation,
  openProjectFolder,
  savePortableProject,
  type ProjectStorageLocation
} from "../../infrastructure/persistence/projectFiles";
import { useEditorStore } from "../../stores/editorStore";

export function ProjectIdentityPanel() {
  const project = useEditorStore((state) => state.project);
  const rename = useEditorStore((state) => state.renameProject);
  const [name, setName] = useState(project.name);
  const [location, setLocation] = useState<ProjectStorageLocation | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(project.name);
    setSavedPath(null);
  }, [project.id, project.name]);
  useEffect(() => {
    let live = true;
    void getProjectStorageLocation()
      .then((value) => {
        if (live) setLocation(value);
      })
      .catch((error) => {
        if (live) setMessage(String(error));
      });
    return () => {
      live = false;
    };
  }, []);
  const open = (path: string) => {
    void openProjectFolder(path).catch((error) => setMessage(String(error)));
  };
  return (
    <section className="grid gap-3 px-3 py-4" aria-label="项目名称与保存位置">
      <label className="grid gap-2 text-xs text-content-muted">
        项目名称
        <input
          aria-label="重命名当前项目"
          className="w-full rounded-lg border border-boundary bg-surface-inset px-3 py-2 text-sm text-content-primary"
          value={name}
          maxLength={180}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => rename(name)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              rename(name);
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      {location ? (
        <>
          <p className="text-xs text-content-muted">
            修改会自动保存在本机项目库。需要移动或备份某个项目时，可另存为项目文件。
          </p>
          <p className="break-all text-xs text-content-subtle" title={location.databasePath}>
            {location.databasePath}
          </p>
          <TextButton onClick={() => open(location.directoryPath)}>
            打开项目库所在文件夹
          </TextButton>
        </>
      ) : (
        <p className="text-xs text-content-muted">浏览器中请保存项目文件，下次导入即可继续。</p>
      )}
      <TextButton
        disabled={busy}
        onClick={() => {
          setBusy(true);
          const id = project.id;
          void savePortableProject(project)
            .then((path) => {
              if (useEditorStore.getState().project.id !== id) return;
              if (path) {
                setSavedPath(path);
                setMessage(`已保存：${path}`);
              }
            })
            .catch((error) => setMessage(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在保存…" : "另存为项目文件…"}
      </TextButton>
      {savedPath && /[\\/]/.test(savedPath) ? (
        <TextButton onClick={() => open(savedPath.replace(/[\\/][^\\/]+$/, ""))}>
          打开项目文件所在文件夹
        </TextButton>
      ) : null}
      {message ? (
        <p role="status" className="break-all text-xs text-content-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}
