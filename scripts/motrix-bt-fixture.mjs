// Local-only BitTorrent fixture. Seeds generated WAV bytes, never films or public swarms.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === "string") return bencode(Buffer.from(value));
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  return Buffer.concat([
    Buffer.from("d"),
    ...Object.keys(value)
      .sort()
      .flatMap((k) => [bencode(k), bencode(value[k])]),
    Buffer.from("e")
  ]);
}
const root = resolve("artifacts/downloads/motrix-bt", randomUUID());
const seedDir = join(root, "seed");
const downloadDir = join(root, "download");
await mkdir(seedDir, { recursive: true });
await mkdir(downloadDir);
const wav = Buffer.alloc(64044);
wav.write("RIFF");
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
wav.writeUInt32LE(wav.length - 44, 40);
// Unique data gives each run an independent infohash, avoiding old task collisions.
Buffer.from(randomUUID()).copy(wav, 44);
const name = "Studio-fixture.wav";
await writeFile(join(seedDir, name), wav);
const pieceLength = 16384;
const pieces = [];
for (let offset = 0; offset < wav.length; offset += pieceLength)
  pieces.push(
    createHash("sha1")
      .update(wav.subarray(offset, offset + pieceLength))
      .digest()
  );
const info = {
  length: wav.length,
  name,
  "piece length": pieceLength,
  pieces: Buffer.concat(pieces)
};
const hash = createHash("sha1").update(bencode(info)).digest("hex");
const seedPort = 49891;
const tracker = createServer((req, res) => {
  if (!req.url?.startsWith("/announce")) {
    res.writeHead(404).end();
    return;
  }
  const peer = Buffer.from([127, 0, 0, 1, seedPort >> 8, seedPort & 255]);
  res
    .writeHead(200, { "content-type": "text/plain" })
    .end(bencode({ interval: 1, complete: 1, incomplete: 0, peers: peer }));
});
await new Promise((resolveReady) => tracker.listen(0, "127.0.0.1", resolveReady));
const trackerUrl = `http://127.0.0.1:${tracker.address().port}/announce`;
const torrentPath = join(root, "fixture.torrent");
await writeFile(torrentPath, bencode({ announce: trackerUrl, info }));
const aria = join(
  process.env.LOCALAPPDATA,
  "Programs/Motrix/resources/extra/win32/x64/aria2c.exe"
);
const seed = spawn(
  aria,
  [
    "--no-conf=true",
    "--enable-dht=false",
    "--enable-dht6=false",
    "--enable-peer-exchange=false",
    "--bt-enable-lpd=false",
    "--check-integrity=true",
    "--seed-time=10",
    "--seed-ratio=0",
    `--listen-port=${seedPort}`,
    "--disable-ipv6=true",
    "--summary-interval=0",
    `--dir=${seedDir}`,
    torrentPath
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
);
let seedOutput = "";
seed.stdout.on("data", (chunk) => {
  seedOutput = (seedOutput + chunk).slice(-4000);
});
seed.stderr.on("data", (chunk) => {
  seedOutput = (seedOutput + chunk).slice(-4000);
});
const manifest = {
  directory: downloadDir,
  uri: `magnet:?xt=urn:btih:${hash}&dn=Studio%20:%20fixture&tr=${encodeURIComponent(trackerUrl)}`,
  expectedSha256: createHash("sha256").update(wav).digest("hex"),
  infoHash: hash
};
const manifestPath = join(root, "fixture.json");
await writeFile(manifestPath, JSON.stringify(manifest));
console.log(JSON.stringify({ manifestPath }));
const shutdown = () => {
  seed.kill();
  tracker.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setTimeout(shutdown, 600000).unref();
seed.on("exit", async (code) => {
  await writeFile(join(root, "seed.log"), seedOutput);
  tracker.close();
  if (code) console.error(`Fixture seed exited (${code})`);
});
