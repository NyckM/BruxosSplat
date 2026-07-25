"""Launches the user-provided MegaSam portable without its final console prompt."""
import argparse
import builtins
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--video', required=True)
    parser.add_argument('--scene', required=True)
    parser.add_argument('--output-root', required=True)
    parser.add_argument('--width', type=int, default=540)
    parser.add_argument('--batch-size', type=int, default=0)
    parser.add_argument('--start-frame', type=int, default=0)
    parser.add_argument('--end-frame', type=int)
    args = parser.parse_args()

    repo = os.path.abspath(args.repo)
    sys.path.insert(0, repo)
    os.chdir(repo)
    # The supplied run_pipeline.py waits for Enter at the very end. Electron
    # has no interactive console, so make that final prompt a no-op.
    builtins.input = lambda *_args, **_kwargs: ''
    sys.argv = ['run_pipeline.py', '-v', os.path.abspath(args.video), '-s', args.scene,
               '-o', os.path.abspath(args.output_root), '-w', str(args.width)]
    if args.batch_size > 0:
        sys.argv += ['--batch_size', str(args.batch_size)]
    if args.start_frame:
        sys.argv += ['--start_frame', str(args.start_frame)]
    if args.end_frame is not None:
        sys.argv += ['--end_frame', str(args.end_frame)]
    from run_pipeline import main as megasam_main
    megasam_main()


if __name__ == '__main__':
    main()
