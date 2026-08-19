#!/usr/bin/env python3
"""Compare GIF frames with an sRGB reference and detect systematic yellow drift."""

import argparse
import math
import sys

from PIL import Image, ImageCms


def signed_lab_delta(value, reference):
    return (value - reference + 128) % 256 - 128


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference_path")
    parser.add_argument("gif_path")
    parser.add_argument("--max-yellow-drift", type=float, default=3.0)
    parser.add_argument("--max-mean-lab-distance", type=float, default=8.0)
    args = parser.parse_args()

    reference = Image.open(args.reference_path)
    gif = Image.open(args.gif_path)
    reference_frames = getattr(reference, "n_frames", 1)
    if reference_frames not in (1, gif.n_frames):
        raise SystemExit(
            f"reference has {reference_frames} frames but GIF has {gif.n_frames}"
        )
    if reference.size != gif.size:
        raise SystemExit(f"size mismatch: reference={reference.size}, GIF={gif.size}")

    srgb_profile = ImageCms.createProfile("sRGB")
    lab_profile = ImageCms.createProfile("LAB")
    b_deltas = []
    lab_distances = []

    for index in range(gif.n_frames):
        reference.seek(index if reference_frames > 1 else 0)
        gif.seek(index)
        reference_rgba = reference.convert("RGBA")
        output_rgba = gif.convert("RGBA")
        reference_lab = ImageCms.profileToProfile(
            reference_rgba.convert("RGB"), srgb_profile, lab_profile, outputMode="LAB"
        )
        output_lab = ImageCms.profileToProfile(
            output_rgba.convert("RGB"), srgb_profile, lab_profile, outputMode="LAB"
        )

        for ref_lab, out_lab, ref_rgba in zip(
            reference_lab.getdata(), output_lab.getdata(), reference_rgba.getdata()
        ):
            if ref_rgba[3] == 0:
                continue
            deltas = [
                signed_lab_delta(out_lab[channel], ref_lab[channel])
                for channel in range(3)
            ]
            b_deltas.append(deltas[2])
            lab_distances.append(math.sqrt(sum(delta * delta for delta in deltas)))

    mean_b_drift = sum(b_deltas) / len(b_deltas)
    mean_lab_distance = sum(lab_distances) / len(lab_distances)
    if abs(mean_b_drift) > args.max_yellow_drift:
        raise SystemExit(
            f"yellow drift {mean_b_drift:.3f} exceeds {args.max_yellow_drift:.3f}"
        )
    if mean_lab_distance > args.max_mean_lab_distance:
        raise SystemExit(
            f"mean Lab distance {mean_lab_distance:.3f} exceeds "
            f"{args.max_mean_lab_distance:.3f}"
        )

    print(
        f"ok: {gif.n_frames} frames, mean_b_drift={mean_b_drift:.3f}, "
        f"mean_lab_distance={mean_lab_distance:.3f}"
    )


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)
