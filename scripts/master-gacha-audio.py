"""Rebuild the gacha soundtrack from the unchanged MP4 files. Requires numpy and FFmpeg.

python scripts/master-gacha-audio.py --ffmpeg /path/to/ffmpeg
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import numpy as np

SR = 48000


def linked_gain(samples, target_db, max_up, max_down):
    """Stereo-linked, 1.5-second smooth gain; retain the original impacts and movement."""
    hop = 2400
    energy = np.array([np.mean(samples[i:i + hop] ** 2) for i in range(0, len(samples), hop)])
    kernel = np.hanning(31)
    kernel /= kernel.sum()
    envelope = np.sqrt(np.convolve(np.pad(energy, (15, 15), mode='edge'), kernel, 'valid'))
    gain = np.clip(10 ** (target_db / 20) / np.maximum(envelope, 1e-7), 10 ** (-max_down / 20), 10 ** (max_up / 20))
    gain = np.convolve(np.pad(gain, (15, 15), mode='edge'), kernel, 'valid')
    return samples * np.interp(np.arange(len(samples)), np.arange(len(gain)) * hop + hop / 2, gain)[:, None]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    folder = root / 'public' / 'gacha'
    report = {}
    for name in ['intro', 'wait', 'open']:
        source = folder / f'gacha-{name}.mp4'
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        raw = subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', str(source), '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', 'pipe:1'], capture_output=True, check=True).stdout
        samples = np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(np.float64)
        if name == 'wait':
            samples = linked_gain(samples, -23, 9, 9)
            count = int(.65 * SR)
            angle = np.linspace(0, np.pi / 2, count)
            overlap = samples[-count:] * np.cos(angle)[:, None] + samples[:count] * np.sin(angle)[:, None]
            # End with the sample immediately preceding the next loop's first sample.
            samples = np.concatenate([samples[count:-count], overlap])
        else:
            samples = linked_gain(samples, -21, 24 if name == 'open' else 6, 12)
            count = int(.02 * SR)
            samples[:count] *= np.linspace(0, 1, count)[:, None]
            if name == 'open':
                count = int(1.2 * SR)
                samples[-count:] *= np.cos(np.linspace(0, np.pi / 2, count))[:, None] ** 2
        output = folder / f'gacha-{name}-audio.wav'
        subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', 'pipe:0', '-af', 'alimiter=limit=0.631:attack=5:release=80:level=0:latency=1', '-c:a', 'pcm_s16le', '-y', str(output)], input=samples.astype('<f4').tobytes(), check=True)
        if name != 'wait':
            encoded = output.with_suffix('.m4a')
            subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', str(output), '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', str(encoded)], check=True)
            output.unlink()  # Only this script's explicitly named intermediate WAV.
            output = encoded
        assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
        report[name] = {'original_sha256': original_hash, 'audio_bytes': output.stat().st_size, 'audio_sha256': hashlib.sha256(output.read_bytes()).hexdigest()}
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
