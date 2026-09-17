import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { LogVarLibraryDialog } from "./LogVarLibraryDialog";
import { LogVarConnectionPanel } from "./LogVarConnectionPanel";
import {
  configureLogvar,
  logvarStatus,
  listLogvarLibrary,
  previewLogvarUpload,
  uploadLogvarXml
} from "../../infrastructure/private-library/logvar";
import type { PublicationDelivery } from "../../domain/publication/types";

vi.mock("../../infrastructure/private-library/logvar", () => ({
  configureLogvar: vi.fn(),
  logvarStatus: vi.fn(),
  listLogvarLibrary: vi.fn(),
  previewLogvarUpload: vi.fn(),
  uploadLogvarXml: vi.fn(),
  clearLogvar: vi.fn(),
  logvarPlayerUrl: vi.fn()
}));
vi.mock("../../infrastructure/private-library/privateLibrary", () => ({
  privateLibraryStatus: () => Promise.resolve({ configured: false }),
  privateLibraryError: (e: unknown) => String(e)
}));
const delivery: PublicationDelivery = {
  projectId: "demo",
  projectName: "demo",
  projectUpdatedAt: "2026-01-01",
  createdAt: "2026-01-01",
  kind: "xml",
  files: [
    { fileName: "Demo.S02E03.xml", content: '<i><d p="1,1,25,16777215,0,0,u,1">demo</d></i>' }
  ]
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logvarStatus).mockResolvedValue({
    configured: true,
    serviceUrl: "https://library.example",
    hasAdminToken: true
  });
  vi.mocked(listLogvarLibrary).mockResolvedValue([]);
  vi.mocked(previewLogvarUpload).mockResolvedValue({
    connectionKey: "scope",
    sourceHash: "hash",
    resourceKey: "demo|2025|tv|s2|3",
    expectedVersion: null,
    count: 1,
    uploadBytes: 80,
    trimmedTextCount: 0
  });
  vi.mocked(uploadLogvarXml).mockResolvedValue({
    verifiedCount: 1,
    resource: {
      title: "Demo",
      year: 2025,
      type: "tv",
      season: 2,
      episode: 3,
      resourceKey: "key",
      count: 1,
      updatedAt: "now",
      filename: "danmaku.json"
    }
  });
});
async function preview() {
  await screen.findByLabelText("正式片名");
  fireEvent.change(screen.getByLabelText("正式片名"), { target: { value: "Demo" } });
  fireEvent.change(screen.getByLabelText("年份"), { target: { value: "2025" } });
  fireEvent.change(screen.getByLabelText("季数"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "预览上传清单" }));
  await screen.findByText(/清单已生成/);
}
test("upload requires a concrete preview and user check; target edits invalidate it", async () => {
  render(<LogVarLibraryDialog delivery={delivery} onClose={() => {}} />);
  await preview();
  expect(screen.getByRole("button", { name: "上传并回读核验" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /我已检查/ }));
  fireEvent.change(screen.getByLabelText("正式片名"), { target: { value: "Another" } });
  expect(screen.queryByRole("button", { name: "上传并回读核验" })).not.toBeInTheDocument();
  expect(uploadLogvarXml).not.toHaveBeenCalled();
});
test("confirmed upload shows actual readback receipt", async () => {
  render(<LogVarLibraryDialog delivery={delivery} onClose={() => {}} />);
  await preview();
  fireEvent.click(screen.getByRole("checkbox", { name: /我已检查/ }));
  fireEvent.click(screen.getByRole("button", { name: "上传并回读核验" }));
  await screen.findByText(/回读一致 · 1 条/);
  expect(uploadLogvarXml).toHaveBeenCalledTimes(1);
  expect(vi.mocked(uploadLogvarXml).mock.calls[0][1]).toEqual({
    title: "Demo",
    year: 2025,
    type: "tv",
    season: 2,
    episode: 3
  });
});
test("append only skips existing episode without writing", async () => {
  vi.mocked(previewLogvarUpload).mockResolvedValue({
    connectionKey: "scope",
    sourceHash: "hash",
    resourceKey: "key",
    expectedVersion: "existing",
    count: 1,
    uploadBytes: 80,
    trimmedTextCount: 0
  });
  render(<LogVarLibraryDialog delivery={delivery} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /只补缺集/ }));
  await preview();
  expect(screen.getByText(/跳过已有集/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /我已检查/ }));
  expect(screen.getByRole("button", { name: "上传并回读核验" })).toBeDisabled();
  expect(uploadLogvarXml).not.toHaveBeenCalled();
});
test("connection keeps embedded token masked and clears entered secrets after save", async () => {
  vi.mocked(logvarStatus).mockResolvedValue({
    configured: false,
    serviceUrl: "",
    hasAdminToken: false
  });
  vi.mocked(configureLogvar).mockResolvedValue({
    configured: true,
    serviceUrl: "https://library.example",
    hasAdminToken: true
  });
  render(<LogVarConnectionPanel />);
  const address = screen.getByLabelText("LogVar 接口地址");
  expect(address).toHaveAttribute("type", "password");
  expect(address).toHaveValue("");
  fireEvent.change(address, { target: { value: "https://library.example/reader/api/v2" } });
  fireEvent.change(screen.getByLabelText("ADMIN_TOKEN（上传权限）"), {
    target: { value: "admin" }
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并保存连接" }));
  await waitFor(() =>
    expect(configureLogvar).toHaveBeenCalledWith({
      apiAddress: "https://library.example/reader/api/v2",
      readToken: "",
      adminToken: "admin"
    })
  );
  await screen.findByText(/连接与读取验证通过/);
  expect(address).toHaveValue("");
  expect(screen.getByLabelText("ADMIN_TOKEN（上传权限）")).toHaveValue("");
});
