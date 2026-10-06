import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const go = process.env.SONG_GO_BINARY || (existsSync('/workspace/.tools/go/bin/go') ? '/workspace/.tools/go/bin/go' : 'go')
const release = join(root, 'release', 'mac-apple-silicon')
const bundle = join(release, 'Sóng.app')
const contents = join(bundle, 'Contents')
const executable = join(contents, 'MacOS', 'song')
const web = join(root, 'launcher', 'web')
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('Run npm run build before packaging.')
rmSync(release, { recursive: true, force: true })
rmSync(web, { recursive: true, force: true })
mkdirSync(join(contents, 'MacOS'), { recursive: true })
mkdirSync(join(contents, 'Resources'), { recursive: true })
cpSync(join(root, 'dist'), web, { recursive: true })

const environment = { ...process.env, GOOS: 'darwin', GOARCH: 'arm64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' }
if (root.startsWith('/workspace/')) {
  environment.GOCACHE = '/workspace/.cache/go'
  environment.GOMODCACHE = '/workspace/.cache/go-mod'
}
execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', executable, '.'], { cwd: join(root, 'launcher'), env: environment, stdio: 'inherit' })
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Sóng</string>
<key>CFBundleDisplayName</key><string>Sóng</string>
<key>CFBundleIdentifier</key><string>app.song.music-library</string>
<key>CFBundleExecutable</key><string>song</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>2</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleIconFile</key><string>song.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`)
cpSync(join(root, 'launcher', 'icon.icns'), join(contents, 'Resources', 'song.icns'))
const licenses = join(release, 'licenses')
mkdirSync(licenses, { recursive: true })
for (const [name, path] of [
  ['React', 'react/LICENSE'], ['ReactDOM', 'react-dom/LICENSE'],
  ['Scheduler', 'scheduler/LICENSE'], ['Lucide', 'lucide-react/LICENSE'],
  ['BeVietnamPro', '@fontsource/be-vietnam-pro/LICENSE'],
]) writeFileSync(join(licenses, `${name}.txt`), readFileSync(join(root, 'node_modules', path)))
const goLicense = resolve(dirname(go), '..', 'LICENSE')
if (existsSync(goLicense)) cpSync(goLicense, join(licenses, 'Go.txt'))
writeFileSync(join(release, 'DOC_TRUOC_KHI_MO.txt'), `SÓNG — LỌC THƯ VIỆN SPOTIFY\n\nDành cho Mac Apple Silicon (M1/M2/M3/M4/M5...), macOS 13 trở lên.\n\n1. Giải nén file ZIP.\n2. Kéo Sóng.app vào Applications rồi mở. Không cần cài Node.js.\n3. App mở trình duyệt mặc định. Bấm Đăng nhập Spotify và cấp quyền trên trang chính thức của Spotify. Client ID đã được gắn sẵn.\n4. Bấm Tự động sắp xếp để gom theo thể loại, ngôn ngữ hoặc cả hai. Xem lại các nhóm rồi tạo những playlist đã chọn trên Spotify. Nhập lịch sử nghe để lọc nghe nhiều / bình thường / ít nghe. Bỏ thích luôn có bước xác nhận.\n\nSPOTIFY\nTrong app ở Developer Dashboard, đăng ký đúng Redirect URI:\nhttp://127.0.0.1:43821/callback\nNếu Spotify báo 403, kiểm tra điều kiện Developer Mode và quyền người dùng trong Dashboard. Không cần Client Secret.\n\nLƯỢT NGHE\nSpotify Web API không cung cấp tổng lượt nghe của tài khoản. Lấy Extended Streaming History từ mục quyền riêng tư Spotify, giải nén rồi nhập từng file JSON. Đếm bản ghi nghe ít nhất 30 giây: nhiều >=10, bình thường 3–9, ít 1–2. Chưa ghi nhận không có nghĩa là chưa từng nghe. Có thể gom theo thói quen nghe gần nhau trong lịch sử. Nhãn thể loại/ngôn ngữ là gợi ý từ metadata, không phải phân tích âm thanh. OpenAI là tuỳ chọn: nhập API key trong app cho lần sắp xếp; API tính phí riêng, không dùng gói ChatGPT.\n\nMỞ APP LẦN ĐẦU\nBản này chưa có chữ ký / notarization Apple Developer. Nếu macOS chặn, xem System Settings > Privacy & Security > Open Anyway. Không cần tắt Gatekeeper. App được biên dịch cho Mac từ Linux và chưa chạy trực tiếp trên máy Mac; giao diện, đăng nhập mô phỏng và chương trình phục vụ được kiểm thử trong cloud. Đăng nhập thật cần Spotify cấp quyền.\n\nDỮ LIỆU\nThư viện và lịch sử lưu trong trình duyệt, token chỉ trong sessionStorage. App không chứa dữ liệu mẫu, mật khẩu hay Client Secret. Chương trình nhỏ chạy nền chỉ phục vụ giao diện tại loopback 127.0.0.1:43821; có thể dừng tiến trình song trong Activity Monitor khi không dùng. Mở app lại sẽ mở thư viện đã lưu.\n`)
const output = process.env.SONG_DOWNLOAD_DIR || join(root, 'release')
mkdirSync(output, { recursive: true })
const archive = join(output, 'Song-macOS-AppleSilicon.zip')
const zipCode = 'from pathlib import Path\nimport sys,zipfile\nroot=Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=9) as z:\n for p in sorted(root.rglob("*")):\n  if p.is_file(): z.write(p,p.relative_to(root).as_posix())\n';
execFileSync('python3', ['-c', zipCode, release, archive], { stdio: 'inherit' })
console.log(`Created ${archive}`)
