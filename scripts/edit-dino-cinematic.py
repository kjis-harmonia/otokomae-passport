"""Re-edit the original Staging dinosaur clips, with identical audio edit points.

Requires FFmpeg with libx264 and librubberband. Rebuilding the intro uses numpy, as does
master-gacha-audio.py, and --raw-dir containing the original Gemini clips.
Supply an untouched source folder
from commit 367703ee43305fb8f688f8f3d78d07705230c52c. Never use the outputs as
inputs: the hashes below reject an accidental second edit.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import runpy

FPS = 24
# The source camera eases out before the cave and eases in after the join.
# Preserve its path, but map those 72 frames to 40 with a monotone C1 curve.
# Knot positions were fitted to the apparent forward motion of the rock walls;
# the floor avoids skipping the short vertical movement at the source join.
ENTRANCE_START = 354 / FPS
ENTRANCE_END = 426 / FPS
ENTRANCE_TARGET_FRAMES = 40
ENTRANCE_REMOVED_FRAMES = 32
INTRO_FRAMES = 631 - ENTRANCE_REMOVED_FRAMES
ENTRANCE_OUTPUT_KNOTS = (
    0.0, 0.245707219259, 0.399765754047, 0.482797593428,
    0.553791612336, 0.622371049138, 0.686114267271, 0.748199204798,
    0.826422915860, 0.961738739033, 1.155161974501, 1.394111645370,
    ENTRANCE_TARGET_FRAMES / FPS,
)


def entrance_polynomials():
    """Monotone Hermite intervals; normal playback speed at both boundaries."""
    y = ENTRANCE_OUTPUT_KNOTS
    secants = [(b - a) / .25 for a, b in zip(y, y[1:])]
    slopes = [1.0, *[2 * a * b / (a + b) for a, b in zip(secants, secants[1:])], 1.0]
    return [(2*a - 2*b + .25*(m+n), -3*a + 3*b - .25*(2*m+n), .25*m, a)
            for a, b, m, n in zip(y, y[1:], slopes, slopes[1:])]


def entrance_pts_expression():
    expression = f'T-{ENTRANCE_REMOVED_FRAMES / FPS:.12f}'
    for i, (a, b, c, d) in reversed(list(enumerate(entrance_polynomials()))):
        z = f'((T-{ENTRANCE_START + i*.25:.12f})/0.25)'
        value = f'{ENTRANCE_START:.12f}+{a:.12f}*{z}*{z}*{z}+{b:.12f}*{z}*{z}+{c:.12f}*{z}+{d:.12f}'
        expression = f'if(lt(T,{ENTRANCE_START + (i+1)*.25:.12f}),{value},{expression})'
    return f'if(lt(T,{ENTRANCE_START:.12f}),T,{expression})/TB'


def entrance_alignment_filter():
    """Remove the source camera reset at frames 370 -> 371, not more time.

    A captured phone playback exposed one backward scale step and an upward
    translation at the raw-shot join. Apply the inverse small pose correction,
    then release it over 18 frames with zero endpoint slope. Sampling remains
    inside the picture; no invented frames, extra dissolve, or black edges.
    """
    u = 'clip((in-371)/18,0,1)'
    weight = f'(1-3*pow({u},2)+2*pow({u},3))'
    zoom = f'(1+0.0263*{weight})'
    left, right = f'W/2-W/(2*{zoom})', f'W/2+W/(2*{zoom})'
    top = f'H/2-H/(2*{zoom})-H*0.00696875*{weight}'
    bottom = f'H/2+H/(2*{zoom})-H*0.00696875*{weight}'
    return (f"perspective=x0='{left}':y0='{top}':x1='{right}':y1='{top}':"
            f"x2='{left}':y2='{bottom}':x3='{right}':y3='{bottom}':"
            "sense=source:interpolation=cubic:eval=frame:enable='between(n,371,388)'")


def landscape_grade_filter(shot):
    """Bring the two outdoor shots toward a common exposure/white balance.

    Keep the mist reveal untouched. Grade the field's final 1.5 seconds,
    then gently release the mountain correction over its first 2 seconds.
    The original cave lighting is restored before the entrance correction.
    No spatial dissolve: these are two distinct camera positions.
    """
    if shot == 'field':
        u = 'clip((n-55)/36,0,1)'
        brightness, red, green, blue, saturation = -.040, -.015, -.005, .035, -.055
    elif shot == 'mountain':
        u = 'clip(n/48,0,1)'
        brightness, red, green, blue, saturation = .035, .015, 0, -.020, -.025
    else:
        raise ValueError(f'Unknown landscape shot: {shot}')
    smooth = f'({u}*{u}*(3-2*{u}))'
    weight = smooth if shot == 'field' else f'(1-{smooth})'
    return (f"eq=brightness='{brightness}*{weight}':gamma_r='1+{red}*{weight}':"
            f"gamma_g='1+{green}*{weight}':gamma_b='1+{blue}*{weight}':"
            f"saturation='1+{saturation}*{weight}':eval=frame")


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
    p.add_argument('--audio-only', action='store_true', help='Regenerate audio after video outputs have already been rendered.')
    p.add_argument('--section', choices=['all', 'intro', 'wait', 'open'], default='all', help='Rebuild one section and its matching audio.')
    p.add_argument('--raw-dir', type=Path, help='Original uploaded Gemini clips; rebuild the intro from clean shots instead of the old baked dissolve.')
    args = p.parse_args()
    src, out = args.source_dir.resolve(), args.output_dir.resolve()
    if src == out:
        p.error('Source and output folders must differ.')
    for name, expected in SOURCE_HASHES.items():
        if hashlib.sha256((src / name).read_bytes()).hexdigest() != expected:
            p.error(f'{name}: not the untouched source; refusing a cumulative re-edit')
    out.mkdir(parents=True, exist_ok=True)
    if args.audio_only and not all((out / f'{name}.mp4').is_file() for name in ['intro', 'wait', 'open']):
        p.error('--audio-only requires the three rendered MP4 files in the output folder')
    raw = {}
    if args.raw_dir:
        for label, suffix, expected in [
            ('montage', '09AA9208.mp4', '6636e0a4c8cba3cf777db51b21e1b8e185439fcdf19b1190689d051604196494'),
            ('rex', '46E9FEC7.mp4', 'fd1a8098c1b2c3f6a664d7029b4a3f00342ac3c5a33754f2d9639a78003e0d14'),
        ]:
            matches = list(args.raw_dir.glob('*' + suffix))
            if len(matches) != 1 or hashlib.sha256(matches[0].read_bytes()).hexdigest() != expected:
                p.error(f'{suffix}: expected exactly one untouched original clip')
            raw[label] = matches[0].resolve()
    if args.section in ['all', 'intro'] and not raw:
        p.error('Intro rebuilding requires --raw-dir; the baked-dissolve fallback is intentionally disabled')

    def run(*cmd):
        subprocess.run([args.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *map(str, cmd)], check=True)

    def video(inputs, graph, name, frames):
        if args.audio_only or args.section not in ['all', name]:
            return
        # trim can clear the nominal frame rate in FFmpeg 7; make each xfade
        # input explicitly CFR as well as sharing a time base.
        graph = graph.replace('settb=AVTB', 'fps=24,settb=AVTB')
        run(*inputs, '-filter_complex_threads', '2', '-filter_complex', graph,
            '-map', '[v]', '-an', '-frames:v', frames, '-r', FPS, '-c:v', 'libx264',
            '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
            '-g', '48', '-movflags', '+faststart', out / f'{name}.mp4')

    def audio(graph, name):
        if args.section not in ['all', name]:
            return
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
        # Keep the Rex disappearing into the mist before the next landscape.
        # Reconstruct the field/mountain join from clean source frames.
        # All edit points and overlaps use whole 24fps frames.
        if raw:
            # The original montage has a hard cut at frame 391. Use its full
            # mountain establishing shot instead of exposing it as a ghost
            # over the flat field. Drop the old 21-frame overlap from the field
            # so the mountain, entrance, and later cues keep their exact times.
            # Raw frame 479 matches old intro frame 467, so the hall continues
            # on the next frame without a second shifted camera viewpoint.
            video(['-i', src / 'intro.mp4', *still, '-i', raw['rex'], '-i', raw['montage']],
                '[2:v]trim=end_frame=228,setpts=PTS-STARTPTS,settb=AVTB[r];'
                '[3:v]split=2[f][m];'
                # One guard frame supplies the CFR tail after the mist xfade;
                # rfcut below fixes the actual scene cut at exactly frame 302.
                '[f]trim=start_frame=278:end_frame=371,setpts=PTS-STARTPTS,settb=AVTB[field];'
                f'[field]{landscape_grade_filter("field")}[f0];'
                '[m]trim=start_frame=391:end_frame=480,setpts=PTS-STARTPTS,settb=AVTB[mountain];'
                f'[mountain]{landscape_grade_filter("mountain")}[m0];'
                '[0:v]trim=start_frame=468:end_frame=708,setpts=PTS-STARTPTS,settb=AVTB[h];'
                '[m0][h]concat=n=2:v=1:a=0,settb=AVTB[mh];'
                '[r][f0]xfade=transition=fade:duration=0.75:offset=8.75[rf];'
                '[rf]trim=end_frame=302,setpts=PTS-STARTPTS,settb=AVTB[rfcut];'
                '[rfcut][mh]concat=n=2:v=1:a=0,settb=AVTB[rfm];'
                f"[rfm]setpts='{entrance_pts_expression()}',fps=24,settb=AVTB[forward];"
                f'[forward]{entrance_alignment_filter()}[aligned];'
                '[1:v]trim=end_frame=10,setpts=PTS-STARTPTS,settb=AVTB[anchor];'
                '[aligned][anchor]xfade=transition=fade:duration=0.416666667:offset=24.541666667,format=yuv420p[v]',
                'intro', INTRO_FRAMES)
        # Hold the same stone briefly, then reveal the already-lit opening.
        # Skip its dark/material-reset frames; join the character at white.
        video(['-i', src / 'open.mp4', *still],
            '[0:v]split=2[x][y];'
            '[x]trim=start_frame=30:end_frame=222,setpts=PTS-STARTPTS,fps=24,tpad=stop_mode=clone:stop=12,settb=AVTB[x0];'
            '[y]trim=start_frame=222:end_frame=364,setpts=PTS-STARTPTS,settb=AVTB[y0];'
            '[1:v]trim=end_frame=12,setpts=PTS-STARTPTS,settb=AVTB[s0];'
            '[s0][x0]xfade=transition=fade:duration=0.416666667:offset=0.083333333[sx];'
            '[sx][y0]concat=n=2:v=1:a=0,format=yuv420p[v]',
            'open', 348)

    # Equal-power sound edits at the exact same positions as the picture.
    # Keep the existing independently mastered, sample-continuous ambient loop.
    if raw and args.section in ['all', 'intro']:
        import numpy as np
        linked_gain = runpy.run_path(str(Path(__file__).with_name('master-gacha-audio.py')))['linked_gain']

        def decode(path):
            pcm = subprocess.run([args.ffmpeg, '-v', 'error', '-i', str(path), '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'], capture_output=True, check=True).stdout
            return np.frombuffer(pcm, dtype='<f4').reshape(-1, 2).astype(np.float64)

        def overlap(a, b, count, easing=False):
            if easing:
                u = np.linspace(0, 1, count)
                u = u*u*(3-2*u)
                angle = u * np.pi / 2
            else:
                angle = np.linspace(0, np.pi / 2, count)
            mix = a[-count:] * np.cos(angle)[:, None] + b[:count] * np.sin(angle)[:, None]
            return np.concatenate([a[:-count], mix, b[count:]])

        rex = linked_gain(decode(raw['rex']), -21, 6, 12)[:456000]
        montage = linked_gain(decode(raw['montage']), -21, 6, 12)
        hall = decode(src / 'intro-audio.m4a')[935000:1416000]
        # Keep source audio continuous through the 12 14/24s picture cut.
        # Start the 1-second sound blend 3/4s later (13 8/24 .. 14 8/24s).
        # The excerpts/overlap retain the exact sample count and return to the
        # previous source timeline before the cave's time-map pre-roll.
        landscape = overlap(montage[556000:824000], montage[818000:960000], 48000, easing=True)
        tail = overlap(landscape, hall, 1000)  # Same source instant, 1/2-frame overlap.
        samples = overlap(rex, tail, 36000)
        if len(samples) != 1262000:
            raise ValueError(f'Raw intro audio length mismatch: {len(samples)}')
        # Pitch-preserving tempo follows the same camera curve. Give the
        # processor pre/post-roll so its startup/flush cannot land on a splice.
        start, end = round(ENTRANCE_START * 48000), round(ENTRANCE_END * 48000)
        context, join = 12000, 480
        target = ENTRANCE_TARGET_FRAMES * 2000 + 2 * join
        source = samples[start-context:end+context].astype('<f4').tobytes()
        scale = 1.0
        for attempt in range(3):
            commands = ['0 rubberband@entrance tempo 1']
            for t in np.arange(0, ENTRANCE_END - ENTRANCE_START, 1/48):
                i = min(11, int(t / .25))
                u = (t - i * .25) / .25
                a, b, c, _ = entrance_polynomials()[i]
                derivative = (3*a*u*u + 2*b*u + c) / .25
                commands.append(f'{t+.25:.9f} rubberband@entrance tempo {scale/derivative:.9f}')
            commands.append('3.25 rubberband@entrance tempo 1')
            filters = ("asetnsamples=n=256:p=0,asendcmd=c='" + ';'.join(commands)
                       + "',rubberband@entrance=tempo=1:transients=smooth:detector=soft:smoothing=on:channels=together")
            pcm = subprocess.run([args.ffmpeg, '-v', 'error', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
                                  '-af', filters, '-f', 'f32le', 'pipe:1'], input=source, capture_output=True, check=True).stdout
            warped = np.frombuffer(pcm, dtype='<f4').reshape(-1, 2).astype(np.float64)
            error = len(warped) - target - 2 * context
            if abs(error) < 128:
                break
            scale *= (len(warped) - 2 * context) / target
        if abs(error) >= 128:
            raise ValueError(f'Entrance audio time-map failed to converge: {error} samples')
        warped = warped[context:-context]
        if len(warped) < target:
            warped = np.pad(warped, ((0, target-len(warped)), (0, 0)), mode='edge')
        warped = warped[:target]

        def splice(a, b):
            w = np.linspace(0, 1, join)[:, None]
            return np.concatenate([a[:-join], a[-join:]*(1-w) + b[:join]*w, b[join:]])

        samples = splice(splice(samples[:start], warped), samples[end:])
        if len(samples) != INTRO_FRAMES * 2000:
            raise ValueError(f'Retimed intro audio length mismatch: {len(samples)}')
        # The old shot boundary also contains a baked-in near-silent dip.
        # Bridge only 15.125 .. 15.750s with the adjacent existing ambience;
        # pitch and duration stay unchanged. Linked gain preserves stereo.
        bridge_start, bridge_end, bridge_fade = 726000, 756000, 6000
        left = samples[690000:720000].copy()
        right = samples[756000:786000].copy()
        angle = np.linspace(0, np.pi / 2, bridge_end-bridge_start)[:, None]
        bed = left*np.cos(angle) + right*np.sin(angle)
        rms = lambda x: max(float(np.sqrt(np.mean(x*x))), 1e-12)
        target_rms = np.sqrt(rms(samples[bridge_start-bridge_fade:bridge_start])
                             * rms(samples[bridge_end:bridge_end+bridge_fade]))
        bed *= np.clip(target_rms/rms(bed), 2**-.5, 2**.5)
        weight = np.ones(bridge_end-bridge_start)
        weight[:bridge_fade] = np.sin(np.linspace(0, np.pi/2, bridge_fade))**2
        weight[-bridge_fade:] = np.cos(np.linspace(0, np.pi/2, bridge_fade))**2
        angle = weight[:, None] * np.pi / 2
        samples[bridge_start:bridge_end] = (samples[bridge_start:bridge_end]*np.cos(angle)
                                          + bed*np.sin(angle))
        subprocess.run([args.ffmpeg, '-v', 'error', '-y', '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
            '-af', 'afade=t=in:d=0.015,alimiter=limit=0.631:attack=5:release=80:level=0:latency=1',
            '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out / 'intro-audio.m4a')],
            input=samples.astype('<f4').tobytes(), check=True)
    # Give the white reveal a half-second breath. Stretch only the existing
    # decay (no new sound); short overlaps avoid an inserted silent gap/click.
    audio('[0:a]asplit=4[s][x][h][y];'
        '[s]atrim=start=0:end=0.5,asetpts=PTS-STARTPTS[s0];'
        '[x]atrim=start=1.25:end=8.75,asetpts=PTS-STARTPTS[x0];'
        '[h]atrim=start=8.75:end=9.25,asetpts=PTS-STARTPTS,atempo=0.6,atempo=0.8,apad,atrim=end_sample=50000[h0];'
        '[y]atrim=start=9.25:end=15.166666667,asetpts=PTS-STARTPTS[y0];'
        '[s0][x0]acrossfade=d=0.416666667:c1=qsin:c2=qsin[sx];'
        '[sx][h0]acrossfade=ns=1000:c1=qsin:c2=qsin[sxh];'
        '[sxh][y0]acrossfade=ns=1000:c1=qsin:c2=qsin,'
        'atrim=end=14.5,afade=t=out:st=13.75:d=0.75[a]', 'open')
    for name in ['intro', 'wait']:
        if args.section not in ['all', name]:
            continue
        run('-i', out / f'{name}.mp4', '-frames:v', '1', '-q:v', '2', out / f'{name}.jpg')
    print(json.dumps({'source_commit': '367703ee43305fb8f688f8f3d78d07705230c52c',
        'raw_sources_sha256': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in raw.items()},
        'frames': {'intro': INTRO_FRAMES, 'wait': 96, 'open': 348},
        'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()}}, indent=2))


if __name__ == '__main__':
    main()
