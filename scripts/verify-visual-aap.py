"""Deterministic, non-private video fixture for the production AAP executable.

Usage: python scripts/verify-visual-aap.py --ffmpeg /absolute/ffmpeg --headless /absolute/alignment_headless --output /temporary/output
Creates its own silent videos; never reads user media.
"""
import argparse
import json
import random
import statistics
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--ffmpeg', required=True, type=Path)
parser.add_argument('--headless', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
ffmpeg = str(args.ffmpeg.resolve())
width, height = 128, 72
rng = random.Random(42317)
frames = []
for frame in range(96):
    blocks = [rng.randrange(25, 225) for _ in range(16 * 9)]
    frames.append(bytes(blocks[(y // 8) * 16 + x // 8] for y in range(height) for x in range(width)))

def video(name, data):
    path = (args.output / name).resolve()
    subprocess.run([ffmpeg, '-y', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'gray',
                    '-video_size', f'{width}x{height}', '-framerate', '4', '-i', 'pipe:0', '-an',
                    '-c:v', 'ffv1', str(path)], input=b''.join(data), check=True, timeout=60)
    return path

target = video('original.mkv', frames)
source_raw = video('edited-reference.mkv', frames[:40] + [bytes(width * height)] * 16 + frames[40:60] + frames[68:])
source = (args.output / 'reference-transcoded.mp4').resolve()
subprocess.run([ffmpeg, '-y', '-v', 'error', '-i', str(source_raw), '-vf', 'eq=brightness=0.04,scale=192:108',
                '-c:v', 'libx264', '-crf', '22', '-an', str(source)], check=True, timeout=60)
started = time.perf_counter()
request = dict(algorithm='visual-aap', sourcePath=str(source), completePath=str(target), ffmpegPath=ffmpeg, spectralBackend='cpu')
result = subprocess.run([str(args.headless.resolve())], input=json.dumps(request).encode(), capture_output=True, timeout=180)
if result.returncode:
    raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))
proposal = json.loads(result.stdout)
(args.output / 'proposal.json').write_text(json.dumps(proposal, ensure_ascii=False, indent=2), encoding='utf-8')
spans = proposal['timeMap']['spans']
matched = [s for s in spans if s['kind'] == 'matched']
assert len(matched) >= 3, f'Expected separate runs before/after insertion/deletion: {[(s["kind"], s["sourceStartMs"], s["sourceEndMs"]) for s in spans]}'
assert not any(s['sourceStartMs'] < 14000 and s['sourceEndMs'] > 10000 for s in matched), 'Filler was mapped into the original'
errors = []
for s in matched:
    for value in range(s['sourceStartMs'], s['sourceEndMs'], 250):
        actual = s['targetStartMs'] + (value - s['sourceStartMs']) * (s['targetEndMs'] - s['targetStartMs']) / (s['sourceEndMs'] - s['sourceStartMs'])
        expected = value if value < 10000 else value - (4000 if value < 19000 else 2000)
        errors.append(abs(actual - expected))
assert max(errors) <= 500, f'Unexpected mapping error: {max(errors)}'
assert proposal['timeMap']['evidence']['audioAnchorCount'] == 0
assert proposal['timeMap']['quality']['level'] != 'verified'
summary = dict(case='synthetic silent video, insertion, deletion, brightness and lossy transcode',
               matchedSegments=len(matched), medianErrorMs=statistics.median(errors), maxErrorMs=max(errors),
               seconds=round(time.perf_counter()-started, 3), scope='Synthetic fixture only; not a real-media accuracy benchmark')
(args.output / 'result.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps(summary))
