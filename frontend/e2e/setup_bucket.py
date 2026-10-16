"""Creates the photos bucket for E2E (or local dev) and lets the web origin PUT/GET it.

Run from backend/ with the API's STORAGE_* env:

    uv run python ../frontend/e2e/setup_bucket.py --origin http://localhost:3000

Phones PUT straight to the bucket and load images from it (ADR-0005), so the bucket needs a CORS
rule for the web origin: PUT with `Content-Type`, and GET. Idempotent: an existing bucket is
kept and its CORS rules replaced. Talks to STORAGE_ENDPOINT (SeaweedFS locally and in CI); the
deployed Tigris bucket's CORS is a deploy step, not this script.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.getcwd())

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

from app.core.config import settings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", action="append", required=True, help="repeatable")
    args = parser.parse_args()
    if not (settings.STORAGE_ENDPOINT and settings.STORAGE_ACCESS_KEY_ID):
        parser.error("STORAGE_ENDPOINT and STORAGE_ACCESS_KEY_ID must be set")

    s3 = boto3.client(
        "s3",
        endpoint_url=settings.STORAGE_ENDPOINT,
        aws_access_key_id=settings.STORAGE_ACCESS_KEY_ID,
        aws_secret_access_key=settings.STORAGE_SECRET_ACCESS_KEY,
        region_name=settings.STORAGE_REGION,
        # Generous retries: in CI this runs right after SeaweedFS's master answers, and its S3
        # gateway can take a moment longer.
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 10, "mode": "standard"},
        ),
    )
    bucket = settings.STORAGE_BUCKET
    try:
        s3.create_bucket(Bucket=bucket)
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") not in (
            "BucketAlreadyOwnedByYou",
            "BucketAlreadyExists",
        ):
            raise
    s3.put_bucket_cors(
        Bucket=bucket,
        CORSConfiguration={
            "CORSRules": [
                {
                    "AllowedOrigins": args.origin,
                    "AllowedMethods": ["PUT", "GET"],
                    "AllowedHeaders": ["content-type"],
                    "MaxAgeSeconds": 600,
                }
            ]
        },
    )
    print(f"bucket {bucket} ready for {', '.join(args.origin)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
