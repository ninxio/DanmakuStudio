// Explicit local integration: own generated WAV, own magnet metadata. No film download.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const ep = JSON.parse(
  await readFile(join(process.env.APPDATA, "Motrix/bridge/endpoint.json"), "utf8")
);
async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${ep.port}/mdxp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.localToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json();
  if (!response.ok || body.error)
    throw new Error(
      `MDXP ${method} failed: ${response.status}, ${body.error?.code ?? ""}, ${body.error?.message ?? ""}`
    );
  return body.result;
}
const root = resolve("artifacts/downloads/motrix-smoke", randomUUID());
await mkdir(root, { recursive: true });
const wav = Buffer.alloc(32044);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(32000, 40);
for (let i = 0; i < 16000; i++)
  wav.writeInt16LE(Math.round(Math.sin((i / 16000) * 440 * Math.PI * 2) * 1000), 44 + i * 2);
const server = createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Length": wav.length,
    "Accept-Ranges": "none"
  });
  res.end(req.method === "HEAD" ? undefined : wav);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ids = [];
try {
  assert.equal((await rpc("engine/status", {})).state, "ready");
  const request = {
    kind: "url",
    uris: [`http://127.0.0.1:${server.address().port}/Studio-connector-test.wav`],
    saveDir: root,
    idempotencyKey: randomUUID()
  };
  const task = await rpc("download/add", request);
  ids.push(task.id);
  assert.equal((await rpc("download/add", request)).id, task.id);
  let current = task;
  for (let i = 0; i < 45; i++) {
    current = (await rpc("task/get", { taskId: task.id })).task;
    if (current?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(current.status, "completed");
  assert.ok(current.finalPath);
  assert.deepEqual(await readFile(current.finalPath), wav);
  // A new legal synthetic torrent identity verifies magnet acceptance and idempotency.
  const info = Buffer.concat([
    Buffer.from(
      "d6:lengthi32044e4:name25:Studio-connector-test.wav12:piece lengthi32768e6:pieces20:"
    ),
    createHash("sha1").update(wav).digest(),
    Buffer.from("e")
  ]);
  const magnetDirectory = join(root, "magnet");
  await mkdir(magnetDirectory);
  const magnetRequest = {
    kind: "magnet",
    uri: `magnet:?xt=urn:btih:${createHash("sha1").update(info).digest("hex")}&dn=Studio-connector-test.wav`,
    saveDir: magnetDirectory,
    idempotencyKey: randomUUID()
  };
  const magnetic = await rpc("download/add", magnetRequest);
  ids.push(magnetic.id);
  assert.equal((await rpc("download/add", magnetRequest)).id, magnetic.id);
  await rpc("task/remove", { taskId: magnetic.id, deleteFiles: false });
  ids.splice(ids.indexOf(magnetic.id), 1);
  assert.equal((await rpc("task/get", { taskId: magnetic.id })).task, null);
  // beta.36 retains files/metadata after task removal; preserve them and use an explicit new directory.
  await assert.rejects(
    rpc("download/add", { ...magnetRequest, idempotencyKey: randomUUID() }),
    /existing-files/
  );
  const retryDirectory = join(root, "retry");
  await mkdir(retryDirectory);
  const recreateRequest = {
    ...magnetRequest,
    saveDir: retryDirectory,
    idempotencyKey: randomUUID()
  };
  const recreated = await rpc("download/add", recreateRequest);
  ids.push(recreated.id);
  assert.notEqual(recreated.id, magnetic.id);
  assert.equal((await rpc("download/add", recreateRequest)).id, recreated.id);
  const report = {
    engineReady: true,
    httpCompleted: true,
    contentVerified: true,
    magnetAccepted: true,
    existingFileConflictPreserved: true,
    magnetRecreatedInNewDirectory: true,
    idempotent: true,
    progress: current.progress,
    finalPath: current.finalPath
  };
  await writeFile(join(root, "verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  for (const taskId of ids) {
    await rpc("task/remove", { taskId, deleteFiles: false });
  }
  server.close();
}
