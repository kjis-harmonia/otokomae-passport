"""Re-edit the original Staging dinosaur clips, with identical audio edit points.

Requires FFmpeg (libx264); no Python packages. Supply an untouched source folder
from commit 367703ee43305fb8f688f8f3d78d07705230c52c. Never use the outputs as
inputs: the hashes below reject an accidental second edit.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

FPS = 24
SOURCE_HASHES = {
    'intro.mp4': '6840d5d70a3b3f94508ce7eaf9849da92f298a6faa9678dcb6d4900ce8c6ed5b',
    'wait.mp4': '5ea34d198db070b73fdf8e919d39ceec250856c87f31d4de7729bdeffe2c1519',
    'open.mp4': '47ae78e8ad392a12efd82c2835f9e3ed3944d63f2590856adb23c368504b858d',
    'intro-audio.m4a': 'cda98bff7e581f181496fffb6879993d115f05e86cff8e85050e8a4814a99a56',
    'open-audio.m4a': 'ee5ac2073780c01631d1e22882272dd9cdef515d0f02f4e86f6ee49c5f900c0c',
}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-dir', type=Path, required=True)
    p.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'public/gacha/dino')
    p.add_argument('--ffmpeg', default='ffmpeg')
    args = p.parse_args()
    src, out = args.source_dir.resolve(), args.output_dir.resolve()
    if src == out:
        p.error('Source and output folders must differ.')
    for name, expected in SOURCE_HASHES.items():
        if hashlib.sha256((src / name).read_bytes()).hexdigest() != expected:
            p.error(f'{name}: not the untouched source; refusing a cumulative re-edit')
    out.mkdir(parents=True, exist_ok=True)

    def run(*cmd):
        subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *map(str, cmd)], check=True)

    def video(inputs, graph, name, frames):
        # trim can clear the nominal frame rate in FFmpeg 7; make each xfade
        # input explicitly CFR as well as sharing a time base.
        graph = graph.replace('settb=AVTB', 'fps=24,settb=AVTB')
        run(*inputs, '-filter_complex_threads', '2', '-filter_complex', graph,
            '-map', '[v]', '-an', '-frames:v', frames, '-r', FPS, '-c:v', 'libx264',
            '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
            '-g', '48', '-movflags', '+faststart', out / f'{name}.mp4')

    def audio(graph, name):
        run('-i', src / f'{name}-audio.m4a', '-filter_complex', graph,
            '-map', '[a]', '-vn', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart', out / f'{name}-audio.m4a')

    # Four-second visual loop. Its final frame approaches source frame 11 and
    # its next frame is source frame 12: motion continues across the wrap.
    video(['-i', src / 'wait.mp4'],
        '[0:v]split=2[w][h];'
        '[w]trim=start_frame=12:end_frame=108,setpts=PTS-STARTPTS,settb=AVTB[w0];'
        '[h]trim=start_frame=0:end_frame=12,setpts=PTS-STARTPTS,settb=AVTB[h0];'
        '[w0][h0]xfade=transition=fade:duration=0.5:offset=3.5,format=yuv420p[v]', 'wait', 96)

    with tempfile.TemporaryDirectory(prefix='ginjiro-dino-') as temp:
        anchor = Path(temp) / 'anchor.png'
        run('-i', out / 'wait.mp4', '-frames:v', '1', anchor)
        still = ['-loop', '1', '-framerate', FPS, '-i', anchor]
        # Remove the long ghosted mist and the baked double-exposed landscape.
        # All edit points and overlaps use whole 24fps frames.
        video(['-i', src / 'intro.mp4', *still],
            '[0:v]split=3[x][y][z];'
            '[x]trim=start_frame=0:end_frame=186,setpts=PTS-STARTPTS,settb=AVTB[x0];'
            '[y]trim=start_frame=273:end_frame=375,setpts=PTS-STARTPTS,settb=AVTB[y0];'
            '[z]trim=start_frame=392:end_frame=708,setpts=PTS-STARTPTS,settb=AVTB[z0];'
            '[x0][y0]xfade=transition=fade:duration=0.5:offset=7.25[xy];'
            '[xy][z0]xfade=transition=fade:duration=0.291666667:offset=11.208333333[xyz];'
            '[1:v]trim=end_frame=10,setpts=PTS-STARTPTS,settb=AVTB[anchor];'
            '[xyz][anchor]xfade=transition=fade:duration=0.416666667:offset=23.958333333,format=yuv420p[v]',
            'intro', 585)
        # Hold the same stone briefly, then reveal the already-lit opening.
        # Skip its dark/material-reset frames; join the character at white.
        video(['-i', src / 'open.mp4', *still],
            '[0:v]split=2[x][y];'
            '[x]trim=start_frame=30:end_frame=212,setpts=PTS-STARTPTS,settb=AVTB[x0];'
            '[y]trim=start_frame=230:end_frame=364,setpts=PTS-STARTPTS,settb=AVTB[y0];'
            '[1:v]trim=end_frame=12,setpts=PTS-STARTPTS,settb=AVTB[s0];'
            '[s0][x0]xfade=transition=fade:duration=0.416666667:offset=0.083333333[sx];'
            '[sx][y0]xfade=transition=fade:duration=0.333333333:offset=7.333333333,format=yuv420p[v]',
            'open', 310)

    # Equal-power sound edits at the exact same positions as the picture.
    # Keep the existing independently mastered, sample-continuous ambient loop.
    audio('[0:a]asplit=3[x][y][z];'
        '[x]atrim=start=0:end=7.75,asetpts=PTS-STARTPTS[x0];'
        '[y]atrim=start=11.375:end=15.625,asetpts=PTS-STARTPTS[y0];'
        '[z]atrim=start=16.333333333:end=29.5,asetpts=PTS-STARTPTS[z0];'
        '[x0][y0]acrossfade=d=0.5:c1=qsin:c2=qsin[xy];'
        '[xy][z0]acrossfade=d=0.291666667:c1=qsin:c2=qsin,'
        'atrim=end=24.375,afade=t=in:d=0.015[a]', 'intro')
    audio('[0:a]asplit=3[s][x][y];'
        '[s]atrim=start=0:end=0.5,asetpts=PTS-STARTPTS[s0];'
        '[x]atrim=start=1.25:end=8.833333333,asetpts=PTS-STARTPTS[x0];'
        '[y]atrim=start=9.583333333:end=15.166666667,asetpts=PTS-STARTPTS[y0];'
        '[s0][x0]acrossfade=d=0.416666667:c1=qsin:c2=qsin[sx];'
        '[sx][y0]acrossfade=d=0.333333333:c1=qsin:c2=qsin,'
        'atrim=end=12.916666667,afade=t=out:st=12.166666667:d=0.75[a]', 'open')
    for name in ['intro', 'wait']:
        run('-i', out / f'{name}.mp4', '-frames:v', '1', '-q:v', '2', out / f'{name}.jpg')
    print(json.dumps({'source_commit': '367703ee43305fb8f688f8f3d78d07705230c52c',
        'frames': {'intro': 585, 'wait': 96, 'open': 310},
        'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()}}, indent=2))


if __name__ == '__main__':
    main()
