"""Re-edit the deep-sea presentation only. Inputs must be preserved originals.

python scripts/edit-deep-gacha.py --source-dir ORIGINALS --output-dir OUTPUT --ffmpeg ffmpeg
Requires numpy. No network, draw RPC, ticket mutation, or paid generation.
"""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import numpy as np

SR = 48000
FPS = 24
FIRST = 9.5
SECOND = 18.5
FADE1 = 10 / FPS  # 0.4 seconds, rounded to complete video frames.
FLASH = 7 / FPS  # 0.3 seconds, rounded to complete video frames.
BURST_END = 116 / FPS
WHITE = 4 / FPS
SWIM_START = 8.0
MUTE_FROM = 12.0  # Original OPEN timeline; excludes the noisy ticket/tail audio.


def crossfade(a, b, seconds):
    n = round(seconds * SR)
    angle = np.linspace(0, np.pi / 2, n)[:, None]
    return np.concatenate([a[:-n], a[-n:] * np.cos(angle) + b[:n] * np.sin(angle), b[n:]])


def result_cue():
    """Original, quiet four-note confirmation; no reused movie/game soundtrack."""
    output = np.zeros((round(.95 * SR), 2), dtype=np.float64)
    for k, frequency in enumerate([523.251, 659.255, 783.991, 1046.502]):
        t = np.arange(round(.5 * SR)) / SR
        attack = np.minimum(t / .012, 1)
        tail = np.minimum((.5 - t) / .08, 1)
        wave = (np.sin(2*np.pi*frequency*t) + .18*np.sin(4*np.pi*frequency*t))
        wave *= attack * np.exp(-7*t) * tail
        start = round(k * .11 * SR)
        output[start:start+len(t)] += wave[:, None]
    output *= .32 / np.max(np.abs(output))
    return output


def render_video(ffmpeg, source, audio, output, name):
    """Stream exact frames through a small seam buffer, without VFR filter inference."""
    width, height = 720, 1280
    frame_bytes = width * height * 3
    decoder = subprocess.Popen([ffmpeg, '-v', 'error', '-threads', '2', '-i', str(source),
        '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], stdout=subprocess.PIPE)
    encoder = subprocess.Popen([ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{width}x{height}', '-r', str(FPS), '-i', 'pipe:0', '-i', str(audio),
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-preset', 'fast', '-crf', '18', '-threads', '2', '-g', '48', '-c:a', 'copy',
        '-movflags', '+faststart', str(output)], stdin=subprocess.PIPE)
    buffer = []
    written = 0
    def emit(frame):
        nonlocal written
        encoder.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
        written += 1
    try:
        index = 0
        while True:
            raw = decoder.stdout.read(frame_bytes)
            if not raw:
                break
            if len(raw) != frame_bytes:
                raise RuntimeError('Incomplete decoded frame')
            frame = np.frombuffer(raw, np.uint8).reshape(height, width, 3)
            if name == 'intro':
                # Original frame domains, before either overlap shortens the timeline.
                if 218 <= index < 228 or 437 <= index < 444:
                    buffer.append(frame.copy())
                elif 228 <= index < 238 or 444 <= index < 451:
                    n = 10 if index < 238 else 7
                    j = index - (228 if n == 10 else 444)
                    t = j / (n - 1)
                    mixed = buffer[j].astype(np.float32) * (1-t) + frame.astype(np.float32) * t
                    if n == 7:
                        flash = np.sin(np.pi*t) ** 2
                        mixed = mixed*(1-flash) + np.array([238, 249, 255], np.float32)*flash
                    emit(mixed)
                    if j == n-1:
                        buffer.clear()
                else:
                    emit(frame)
            else:
                if index < 116:
                    if index >= 110:
                        t = (index-109) / 6
                        frame = frame.astype(np.float32)*(1-t) + 255*t
                    emit(frame)
                elif index >= 192:
                    if index == 192:
                        for _ in range(4):
                            emit(np.full((height, width, 3), 255, np.uint8))
                    if index < 204:
                        t = (index-191) / 12
                        frame = frame.astype(np.float32)*t + 255*(1-t)
                    emit(frame)
            index += 1
        assert index == (692 if name == 'intro' else 396), (name, index)
        assert written == (675 if name == 'intro' else 324), (name, written)
    finally:
        decoder.stdout.close()
        encoder.stdin.close()
    if decoder.wait() != 0 or encoder.wait() != 0:
        raise RuntimeError('Video decoder/encoder failed')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-dir', type=Path, required=True)
    p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--ffmpeg', default='ffmpeg')
    args = p.parse_args()
    src, out = args.source_dir.resolve(), args.output_dir.resolve()
    if src == out:
        p.error('Preserve the originals: source-dir and output-dir must differ.')
    out.mkdir(parents=True, exist_ok=True)
    report = {'source_sha256': {}, 'timing': {'first_join_source': FIRST, 'second_join_source': SECOND,
              'first_crossfade': FADE1, 'blue_flash': FLASH, 'burst_source_end': BURST_END,
              'white_hold': WHITE, 'swimmer_source_start': SWIM_START, 'source_audio_silent_from': MUTE_FROM}}

    def run(*cmd, data=None, capture=False):
        return subprocess.run([args.ffmpeg, '-v', 'error', '-nostdin', '-y', *map(str, cmd)],
                              input=data, stdout=subprocess.PIPE if capture else None, check=True)

    def read_audio(name):
        f = src / f'gacha-{name}-audio.m4a'
        raw = run('-i', f, '-vn', '-ac', 2, '-ar', SR, '-f', 'f32le', 'pipe:1', capture=True).stdout
        return np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(np.float64)

    def encode_audio(samples, name):
        # Explicit true silence and fades are kept in PCM. AAC tail is checked after decoding.
        peak = float(np.max(np.abs(samples)))
        if peak > .62:
            samples *= .62 / peak
        run('-f', 'f32le', '-ar', SR, '-ac', 2, '-i', 'pipe:0',
            '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out / name,
            data=samples.astype('<f4').tobytes())

    originals = ['gacha-intro.mp4', 'gacha-intro-audio.m4a', 'gacha-open.mp4', 'gacha-open-audio.m4a']
    for name in originals:
        report['source_sha256'][name] = hashlib.sha256((src / name).read_bytes()).hexdigest()

    intro = read_audio('intro')
    intro = crossfade(crossfade(intro[:round(FIRST*SR)], intro[round(FIRST*SR):round(SECOND*SR)], FADE1),
                      intro[round(SECOND*SR):], FLASH)
    # Match video duration exactly, excluding AAC encoder padding from the input.
    intro = intro[:round((692 / FPS - FADE1 - FLASH) * SR)]
    encode_audio(intro, 'gacha-intro-audio.m4a')

    opening = read_audio('open')
    end = round(MUTE_FROM * SR)
    n = round(.3 * SR)
    opening[end-n:end] *= np.linspace(1, 0, n)[:, None] ** 2
    opening[end:] = 0
    # Audio crosses underneath the white frame; never insert an audio gap with the visual cut.
    opening = crossfade(opening[:round(5.5*SR)], opening[round(SWIM_START*SR):round(16.5*SR)], .5)
    assert len(opening) == round(13.5 * SR)
    assert np.max(np.abs(opening[round(9 * SR):])) == 0
    encode_audio(opening, 'gacha-open-audio.m4a')
    encode_audio(result_cue(), 'gacha-result-audio.m4a')

    print('RENDER intro', flush=True)
    render_video(args.ffmpeg, src/'gacha-intro.mp4', out/'gacha-intro-audio.m4a', out/'gacha-intro.mp4', 'intro')
    print('RENDER opening', flush=True)
    render_video(args.ffmpeg, src/'gacha-open.mp4', out/'gacha-open-audio.m4a', out/'gacha-open.mp4', 'open')

    for name, expected in report['source_sha256'].items():
        assert hashlib.sha256((src/name).read_bytes()).hexdigest() == expected
    report['output_sha256'] = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in out.iterdir() if f.suffix in ['.mp4', '.m4a']}
    (out/'edit-report.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print('DONE', out, flush=True)


if __name__ == '__main__':
    main()
