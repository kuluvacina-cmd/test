#!/usr/bin/env bash
set -euo pipefail
cd /workspace/test
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) throw new Error("Sóng requires Node.js 22.12+; use the preinstalled Node 24 runtime.")'
export VITE_SPOTIFY_CLIENT_ID="${VITE_SPOTIFY_CLIENT_ID:-a5f0a0a5c8674cd29552b64b57579f2a}"
export VITE_SPOTIFY_REDIRECT_PATH="${VITE_SPOTIFY_REDIRECT_PATH:-/callback}"
npm ci --cache /workspace/.cache/npm --no-audit --no-fund
npm test
npm run build
mkdir -p /workspace/.tools /workspace/.cache/go /workspace/.cache/go-mod
if [ ! -x /workspace/.tools/go/bin/go ]; then
  curl --fail --location --silent --show-error https://dl.google.com/go/go1.27.1.linux-amd64.tar.gz -o /tmp/song-go1.27.1.tar.gz
  printf '%s\n' '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445  /tmp/song-go1.27.1.tar.gz' | sha256sum --check -
  tar -xzf /tmp/song-go1.27.1.tar.gz -C /workspace/.tools
fi
/workspace/.tools/go/bin/go version
python3 - <<'PY'
import hashlib, os, pathlib, shutil, tempfile, urllib.request, zipfile
sdk=pathlib.Path("/workspace/.tools/android-sdk")
packages=[
("platform-36_r02.zip","2c1a80dd4d9f7d0e6dd336ec603d9b5c55a6f576",sdk/"platforms/android-36","android.jar"),
("build-tools_r36_linux.zip","b0b6376977657e8ad9b969bacf4093601da2c6fb",sdk/"build-tools/36.0.0","aapt2"),
]
for name,checksum,target,marker in packages:
    if (target/marker).is_file(): continue
    archive=pathlib.Path("/tmp")/("song-"+name)
    urllib.request.urlretrieve("https://dl.google.com/android/repository/"+name,archive)
    if hashlib.sha1(archive.read_bytes()).hexdigest()!=checksum: raise RuntimeError("Android SDK checksum mismatch")
    with tempfile.TemporaryDirectory(prefix="song-sdk-",dir="/tmp") as folder:
        root=pathlib.Path(folder)
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                path=(root/info.filename).resolve()
                if not path.is_relative_to(root): raise RuntimeError("Invalid SDK archive path")
                z.extract(info,root)
                mode=info.external_attr>>16
                if mode and path.is_file(): path.chmod(mode & 0o777)
        candidates=list(root.rglob(marker))
        if len(candidates)!=1: raise RuntimeError("Unexpected Android SDK layout")
        target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists(): shutil.rmtree(target)
        shutil.move(str(candidates[0].parent),str(target))
print("Android platform 36 and build-tools 36.0.0 ready")
PY
java --module jdk.compiler/com.sun.tools.javac.Main -version
mkdir -p launcher/web
cp -R dist/. launcher/web/
(
  cd launcher
  GOTOOLCHAIN=local GOCACHE=/workspace/.cache/go GOMODCACHE=/workspace/.cache/go-mod /workspace/.tools/go/bin/go test ./...
)
SONG_DOWNLOAD_DIR=/workspace/downloads GOMAXPROCS=2 node scripts/package-mac.mjs
SONG_DOWNLOAD_DIR=/workspace/downloads node scripts/package-android.mjs

