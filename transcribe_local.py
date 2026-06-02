#!/usr/bin/env python3
"""Transcribe an audio file with faster-whisper; print the transcript to stdout.

Usage: transcribe_local.py <audio_path> [model]

The model defaults to "base". Device and compute type can be overridden with the
TELEGRAM_WHISPER_DEVICE (cpu | cuda | auto) and TELEGRAM_WHISPER_COMPUTE
(int8 | int8_float16 | float16 | float32) environment variables. faster-whisper
decodes audio via bundled PyAV, so a separate ffmpeg binary is not required.
"""
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: transcribe_local.py <audio_path> [model]\n")
        return 2

    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write("faster-whisper not installed (pip install faster-whisper)\n")
        return 3

    device = os.environ.get("TELEGRAM_WHISPER_DEVICE", "auto")
    compute = os.environ.get("TELEGRAM_WHISPER_COMPUTE", "int8")

    model = WhisperModel(model_name, device=device, compute_type=compute)
    segments, _info = model.transcribe(audio)
    sys.stdout.write("".join(seg.text for seg in segments).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
