#!/usr/bin/env python3
"""Download and verify a same-run Actions artifact with bounded transient retries."""

import argparse
from email.message import Message
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import sys
import tempfile
import time
import unittest
from unittest import mock
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
import zipfile

RETRY_DELAYS = (10, 30, 60)
MAX_ATTEMPTS = len(RETRY_DELAYS) + 1
CHUNK_SIZE = 1024 * 1024


class DownloadError(RuntimeError):
    """An artifact could not be resolved, downloaded, or verified."""


class StripAuthorizationRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            # The artifact API redirects to a signed host, which does not need the workflow token.
            redirected.remove_header("Authorization")
        return redirected


def is_transient(error):
    if isinstance(error, HTTPError):
        return 500 <= error.code <= 599
    if isinstance(error, URLError):
        return True
    return isinstance(error, (TimeoutError, socket.timeout, ConnectionError,
                              http.client.IncompleteRead, http.client.RemoteDisconnected))


def describe_error(error):
    if isinstance(error, HTTPError):
        return f"HTTP {error.code} {error.reason}"
    return f"{type(error).__name__}: {error}"


def retry_call(operation, label, pause=time.sleep, *, extra_retryable_statuses=()):
    """Retry transient transport failures and explicitly allowed HTTP statuses."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            return operation()
        except Exception as error:
            detail = describe_error(error)
            if isinstance(error, HTTPError):
                error.close()
            if not (is_transient(error) or
                    isinstance(error, HTTPError) and error.code in extra_retryable_statuses):
                raise DownloadError(f"{label}: failed immediately ({detail})") from error
            if attempt == MAX_ATTEMPTS - 1:
                raise DownloadError(f"{label}: failed after {MAX_ATTEMPTS} attempts ({detail})") from error
            pause(RETRY_DELAYS[attempt])
    raise AssertionError("unreachable")


def api_url(api_base, repository, route):
    return api_base.rstrip("/") + "/repos/" + quote(repository, safe="/") + route


def request_json(url, token):
    request = Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def artifact_metadata(args, token):
    base = api_url(args.api_url, args.repository, "")
    if args.artifact_id:
        artifact_id = args.artifact_id
    else:
        route = f"/actions/runs/{quote(args.run_id, safe='')}/artifacts?" + urlencode({
            "name": args.artifact_name,
            "per_page": 100,
        })
        inventory = retry_call(
            lambda: request_json(base + route, token),
            f"artifact lookup for {args.artifact_name}",
        )
        matches = [item for item in inventory.get("artifacts", [])
                   if item.get("name") == args.artifact_name and not item.get("expired")]
        if not matches:
            raise DownloadError(
                f"artifact not downloaded: no unexpired artifact named {args.artifact_name} "
                f"in run {args.run_id}"
            )
        # A rerun can leave earlier immutable artifacts with the same name; use the newest ID.
        artifact_id = str(max(matches, key=lambda item: item["id"])["id"])

    metadata = retry_call(
        lambda: request_json(base + f"/actions/artifacts/{quote(str(artifact_id), safe='')}", token),
        f"artifact metadata for {args.artifact_name or artifact_id}",
    )
    if metadata.get("expired"):
        raise DownloadError(f"artifact not downloaded: artifact {artifact_id} is expired")
    return base, metadata


def download_archive(url, token, archive_path):
    request = Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    opener = build_opener(StripAuthorizationRedirectHandler)
    with opener.open(request, timeout=60) as response, archive_path.open("wb") as output:
        while True:
            chunk = response.read(CHUNK_SIZE)
            if not chunk:
                break
            output.write(chunk)


def verify_digest(archive_path, expected):
    if not isinstance(expected, str) or not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", expected):
        raise DownloadError("artifact not downloaded: GitHub did not provide a valid SHA-256 digest")
    digest = hashlib.sha256()
    with archive_path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    wanted = expected.split(":", 1)[1].lower()
    if actual != wanted:
        raise DownloadError(
            f"artifact not downloaded: SHA-256 digest mismatch (expected {wanted}, got {actual})"
        )


def extract_archive(archive_path, destination):
    staging = archive_path.parent / "contents"
    staging.mkdir()
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                path = PurePosixPath(member.filename)
                if path.is_absolute() or ".." in path.parts:
                    raise DownloadError(f"artifact not downloaded: unsafe archive path {member.filename!r}")
            archive.extractall(staging)
    except zipfile.BadZipFile as error:
        raise DownloadError(f"artifact not downloaded: invalid ZIP archive ({error})") from error
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(staging, destination, dirs_exist_ok=True)


def download_artifact(args):
    token = os.environ["GH_TOKEN"]
    base, metadata = artifact_metadata(args, token)
    artifact_id = metadata.get("id")
    if artifact_id is None:
        raise DownloadError("artifact not downloaded: GitHub returned metadata without an artifact ID")
    archive_url = base + f"/actions/artifacts/{quote(str(artifact_id), safe='')}/zip"
    destination = Path(args.path)
    try:
        with tempfile.TemporaryDirectory(prefix="ci-artifact-") as temporary:
            archive_path = Path(temporary) / "artifact.zip"

            def fetch_and_verify():
                download_archive(archive_url, token, archive_path)
                verify_digest(archive_path, metadata.get("digest"))

            label = f"artifact download for {metadata.get('name', artifact_id)}"
            try:
                # The lookup proved the artifact exists; GitHub can serve its archive later than its metadata.
                retry_call(fetch_and_verify, label, extra_retryable_statuses=(404,))
            except DownloadError as error:
                if isinstance(error.__cause__, HTTPError) and error.__cause__.code == 404:
                    raise DownloadError(
                        f"{label}: metadata was found but its archive stayed unavailable "
                        f"after {MAX_ATTEMPTS} attempts ({describe_error(error.__cause__)})"
                    ) from error
                raise
            extract_archive(archive_path, destination)
    except DownloadError as error:
        if str(error).startswith("artifact not downloaded:"):
            raise
        raise DownloadError(f"artifact not downloaded: {error}") from error
    except Exception as error:
        raise DownloadError(f"artifact not downloaded: {type(error).__name__}: {error}") from error
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--artifact-id", help="immutable artifact ID selected by the wait step")
    selection.add_argument("--artifact-name", help="artifact name to resolve in the current run")
    parser.add_argument("--path", required=True, help="directory to extract the artifact into")
    parser.add_argument("--api-url", default=os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID"))
    args = parser.parse_args()
    if not args.repository or not args.run_id:
        parser.error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required")
    try:
        metadata = download_artifact(args)
    except Exception as error:
        message = str(error)
        if not message.startswith("artifact not downloaded:"):
            message = "artifact not downloaded: " + message
        sys.exit(message)
    print(f"Downloaded artifact {metadata.get('name', metadata['id'])}; SHA-256 verified at {args.path}")


class RetryTests(unittest.TestCase):
    def test_archive_404_retries_then_succeeds(self):
        args = argparse.Namespace(artifact_id="42", artifact_name=None, api_url="https://api.example.invalid",
                                  repository="owner/repo", path="unused")
        metadata = {"id": 42, "name": "build"}
        missing = HTTPError("https://api.example.invalid", 404, "Not Found", Message(), None)
        with mock.patch.dict(os.environ, GH_TOKEN="token"), \
             mock.patch(f"{__name__}.request_json", return_value=metadata) as lookup, \
             mock.patch(f"{__name__}.download_archive", side_effect=[missing, None]) as download, \
             mock.patch(f"{__name__}.verify_digest"), \
             mock.patch(f"{__name__}.extract_archive") as extract, \
             mock.patch(f"{__name__}.RETRY_DELAYS", (0, 0, 0)):
            self.assertEqual(download_artifact(args), metadata)
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual(download.call_count, 2)
        extract.assert_called_once()

    def test_archive_403_fails_immediately(self):
        args = argparse.Namespace(artifact_id="42", artifact_name=None, api_url="https://api.example.invalid",
                                  repository="owner/repo", path="unused")
        forbidden = HTTPError("https://api.example.invalid", 403, "Forbidden", Message(), None)
        with mock.patch.dict(os.environ, GH_TOKEN="token"), \
             mock.patch(f"{__name__}.request_json", return_value={"id": 42, "name": "build"}), \
             mock.patch(f"{__name__}.download_archive", side_effect=forbidden) as download, \
             mock.patch(f"{__name__}.extract_archive") as extract:
            with self.assertRaisesRegex(DownloadError, r"failed immediately \(HTTP 403 Forbidden\)"):
                download_artifact(args)
        self.assertEqual(download.call_count, 1)
        extract.assert_not_called()

    def test_archive_404_exhaustion_explains_metadata_was_found(self):
        args = argparse.Namespace(artifact_id="42", artifact_name=None, api_url="https://api.example.invalid",
                                  repository="owner/repo", path="unused")
        missing = HTTPError("https://api.example.invalid", 404, "Not Found", Message(), None)
        with mock.patch.dict(os.environ, GH_TOKEN="token"), \
             mock.patch(f"{__name__}.request_json", return_value={"id": 42, "name": "build"}), \
             mock.patch(f"{__name__}.download_archive", side_effect=missing) as download, \
             mock.patch(f"{__name__}.extract_archive") as extract, \
             mock.patch(f"{__name__}.RETRY_DELAYS", (0, 0, 0)):
            with self.assertRaisesRegex(
                DownloadError,
                r"artifact download for build: metadata was found but its archive stayed unavailable "
                r"after 4 attempts \(HTTP 404 Not Found\)",
            ):
                download_artifact(args)
        self.assertEqual(download.call_count, 4)
        extract.assert_not_called()

    def test_lookup_404_fails_immediately_for_metadata_and_inventory(self):
        for artifact_id, artifact_name in (("42", None), (None, "build")):
            with self.subTest(artifact_id=artifact_id, artifact_name=artifact_name):
                args = argparse.Namespace(artifact_id=artifact_id, artifact_name=artifact_name,
                                          api_url="https://api.example.invalid", repository="owner/repo",
                                          run_id="123")
                missing = HTTPError("https://api.example.invalid", 404, "Not Found", Message(), None)
                with mock.patch(f"{__name__}.request_json", side_effect=missing) as lookup:
                    with self.assertRaisesRegex(DownloadError, r"failed immediately \(HTTP 404"):
                        artifact_metadata(args, "token")
                self.assertEqual(lookup.call_count, 1)

    def test_expected_digest_is_checked(self):
        contents = b"verified artifact archive"
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "artifact.zip"
            archive.write_bytes(contents)
            expected = hashlib.sha256(contents).hexdigest()
            verify_digest(archive, "sha256:" + expected)
            with self.assertRaisesRegex(DownloadError, "SHA-256 digest mismatch"):
                verify_digest(archive, "sha256:" + "0" * 64)

    def test_transient_5xx_retries_then_succeeds(self):
        calls = []
        pauses = []

        def request():
            calls.append(None)
            if len(calls) == 1:
                raise HTTPError("https://api.example.invalid", 502, "Bad Gateway", Message(), None)
            return "downloaded"

        self.assertEqual(retry_call(request, "artifact download", pauses.append), "downloaded")
        self.assertEqual(len(calls), 2)
        self.assertEqual(pauses, [10])

    def test_network_reset_retries_then_succeeds(self):
        calls = []
        pauses = []

        def request():
            calls.append(None)
            if len(calls) == 1:
                raise URLError(ConnectionResetError("connection reset"))
            return "downloaded"

        self.assertEqual(retry_call(request, "artifact download", pauses.append), "downloaded")
        self.assertEqual(len(calls), 2)
        self.assertEqual(pauses, [10])

    def test_http_4xx_fails_immediately(self):
        calls = []
        pauses = []

        def request():
            calls.append(None)
            raise HTTPError("https://api.example.invalid", 404, "Not Found", Message(), None)

        with self.assertRaisesRegex(DownloadError, "failed immediately \\(HTTP 404"):
            retry_call(request, "artifact lookup", pauses.append)
        self.assertEqual(len(calls), 1)
        self.assertEqual(pauses, [])

    def test_exhausted_transient_retries_fail_clearly(self):
        calls = []
        pauses = []

        def request():
            calls.append(None)
            raise HTTPError("https://api.example.invalid", 503, "Service Unavailable", Message(), None)

        with self.assertRaisesRegex(DownloadError, "failed after 4 attempts \\(HTTP 503"):
            retry_call(request, "artifact download", pauses.append)
        self.assertEqual(len(calls), 4)
        self.assertEqual(pauses, [10, 30, 60])


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[sys.argv[0]], verbosity=2)
    else:
        main()
