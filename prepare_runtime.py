"""Remove GazeFollower 1.0.2's import-time desktop objects in this venv only."""
from importlib.metadata import distribution
from pathlib import Path
import sys

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    if Path(sys.prefix).resolve() != root / '.venv':
        raise SystemExit('Run with .venv/Scripts/python.exe; global installations are not modified.')
    dist = distribution('gazefollower')
    if dist.version != '1.0.2':
        raise SystemExit('This compatibility patch is only for gazefollower 1.0.2.')
    for name, eager in [('__init__.py', 'from .GazeFollower import GazeFollower'),
                        ('misc/__init__.py', 'from .Recorder import *')]:
        path = Path(dist.locate_file('gazefollower/' + name))
        before = path.read_text(encoding='utf-8')
        if eager in before:
            path.write_text(before.replace(eager, '# ROI: omit desktop UI imports and their initialization side effects.'), encoding='utf-8')
    # MediaPipe's native graph loader cannot open this workspace's Korean path on Windows.
    mp = distribution('mediapipe')
    if mp.version != '0.10.21':
        raise SystemExit('Expected mediapipe 0.10.21.')
    path = Path(mp.locate_file('mediapipe/python/solution_base.py'))
    text = path.read_text(encoding='utf-8')
    original = 'root_path = os.sep.join(os.path.abspath(__file__).split(os.sep)[:-3])'
    text = text.replace(original, "root_path = os.environ.get('ROI_MEDIAPIPE_RESOURCE_DIR') or os.sep.join(os.path.abspath(__file__).split(os.sep)[:-3])")
    path.write_text(text, encoding='utf-8')
    print('GazeFollower component imports prepared (no desktop defaults).')
