#!/usr/bin/env python3
"""Check that every GIF frame keeps the requested rounded corners transparent."""

import argparse
import sys

from PIL import Image


def outside_rounded_rect(x, y, width, height, radius):
    if radius <= 0:
        return False
    if x < radius and y < radius:
        return (x - radius) ** 2 + (y - radius) ** 2 > radius ** 2
    if x >= width - radius and y < radius:
        return (x - (width - radius - 1)) ** 2 + (y - radius) ** 2 > radius ** 2
    if x < radius and y >= height - radius:
        return (x - radius) ** 2 + (y - (height - radius - 1)) ** 2 > radius ** 2
    if x >= width - radius and y >= height - radius:
        return (x - (width - radius - 1)) ** 2 + (y - (height - radius - 1)) ** 2 > radius ** 2
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gif_path")
    parser.add_argument("--radius-ratio", type=float, required=True)
    parser.add_argument("--expected-delay", type=int)
    args = parser.parse_args()

    image = Image.open(args.gif_path)
    width, height = image.size
    radius = min(width, height) * max(0.0, min(0.5, args.radius_ratio))
    frame_sizes = set()
    delays = set()
    transparent_counts = []

    for index in range(image.n_frames):
        image.seek(index)
        frame = image.convert("RGBA")
        frame_sizes.add(frame.size)
        delays.add(image.info.get("duration"))
        pixels = frame.load()
        outside_opaque = 0
        transparent_count = 0
        for y in range(height):
            for x in range(width):
                alpha = pixels[x, y][3]
                if alpha == 0:
                    transparent_count += 1
                elif outside_rounded_rect(x, y, width, height, radius):
                    outside_opaque += 1
        if outside_opaque:
            raise SystemExit(
                f"frame {index}: {outside_opaque} opaque pixels outside rounded corners"
            )
        transparent_counts.append(transparent_count)

    if len(frame_sizes) != 1:
        raise SystemExit(f"inconsistent frame sizes: {sorted(frame_sizes)}")
    if args.expected_delay is not None and delays != {args.expected_delay}:
        raise SystemExit(f"unexpected frame delays: {sorted(delays)}")
    if len(set(transparent_counts)) != 1:
        raise SystemExit(
            f"unstable transparent pixel counts: {min(transparent_counts)}..{max(transparent_counts)}"
        )

    print(
        f"ok: {image.n_frames} frames, {width}x{height}, "
        f"delays={sorted(delays)}, transparent={min(transparent_counts)}..{max(transparent_counts)}"
    )


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)
