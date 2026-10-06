import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = process.env.SONG_ANDROID_SDK || '/workspace/.tools/android-sdk'
const tools = join(sdk, 'build-tools', '36.0.0')
const androidJar = join(sdk, 'platforms', 'android-36', 'android.jar')
const main = join(root, 'android', 'app', 'src', 'main')
const work = join(root, 'android', 'build')
const java = process.env.SONG_JAVA_BINARY || 'java'
const keytool = process.env.SONG_KEYTOOL_BINARY || 'keytool'
const output = process.env.SONG_DOWNLOAD_DIR || join(root, 'release')
if (!existsSync(androidJar) || !existsSync(join(tools, 'aapt2'))) throw new Error('Android SDK platform 36 and build tools 36.0.0 are required.')
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('Run npm run build first.')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const assets = join(main, 'assets')
rmSync(join(assets, 'web'), { recursive: true, force: true })
cpSync(join(root, 'dist'), join(assets, 'web'), { recursive: true })
const notices = join(assets, 'web', 'licenses')
mkdirSync(notices, { recursive: true })
for (const [label, path] of [['React', 'react/LICENSE'], ['ReactDOM', 'react-dom/LICENSE'], ['Scheduler', 'scheduler/LICENSE'], ['Lucide', 'lucide-react/LICENSE'], ['BeVietnamPro', '@fontsource/be-vietnam-pro/LICENSE']]) {
  cpSync(join(root, 'node_modules', path), join(notices, `${label}.txt`))
}
const compiled = join(work, 'resources.zip')
const base = join(work, 'unsigned.apk')
const generated = join(work, 'generated')
const classes = join(work, 'classes')
const dex = join(work, 'dex')
for (const folder of [generated, classes, dex]) mkdirSync(folder, { recursive: true })
const run = (binary, args) => execFileSync(binary, args, { cwd: root, stdio: 'inherit' })
run(join(tools, 'aapt2'), ['compile', '--dir', join(main, 'res'), '-o', compiled])
run(join(tools, 'aapt2'), ['link', '-o', base, '--manifest', join(main, 'AndroidManifest.xml'), '-I', androidJar, '--java', generated, '--min-sdk-version', '26', '--target-sdk-version', '36', '--version-code', '2', '--version-name', '0.2.0', '-A', assets, compiled])
function filesUnder(folder, suffix) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(join(folder, entry.name), suffix) : entry.name.endsWith(suffix) ? [join(folder, entry.name)] : [])
}
run(java, ['--module', 'jdk.compiler/com.sun.tools.javac.Main', '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-classpath', androidJar, '-d', classes, ...filesUnder(generated, '.java'), ...filesUnder(join(main, 'java'), '.java')])
run(java, ['-cp', join(tools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--min-api', '26', '--lib', androidJar, '--output', dex, ...filesUnder(classes, '.class')])
run('python3', ['-c', 'import pathlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"a",zipfile.ZIP_DEFLATED) as z:\n for p in pathlib.Path(sys.argv[2]).glob("*.dex"): z.write(p,p.name)\n', base, dex])
const aligned = join(work, 'aligned.apk')
run(join(tools, 'zipalign'), ['-f', '4', base, aligned])
const keys = process.env.SONG_ANDROID_KEY_DIR || '/workspace/.tools/android-signing'
mkdirSync(keys, { recursive: true })
const key = join(keys, 'song-debug.keystore')
// This is a local debug signing key, not a Spotify/OpenAI credential.
if (!existsSync(key)) run(keytool, ['-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Sóng Local Build,O=Sóng,C=VN'])
mkdirSync(output, { recursive: true })
const apk = join(output, 'Song-Android.apk')
run(java, ['-jar', join(tools, 'lib', 'apksigner.jar'), 'sign', '--ks', key, '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, aligned])
run(java, ['-jar', join(tools, 'lib', 'apksigner.jar'), 'verify', '--verbose', apk])
run(join(tools, 'zipalign'), ['-c', '4', apk])
writeFileSync(join(output, 'ANDROID-DOC-TRUOC.txt'), 'Sóng Android: Android 8.0 trở lên. Mở APK và cho phép cài từ nguồn bạn đã tải nếu Android yêu cầu. Bản cài ký cục bộ, không phải bản Google Play. Đăng nhập trên trang Spotify chính thức; Redirect URI trong Dashboard: http://127.0.0.1:43821/callback. Client ID đã gắn sẵn. Nhập lịch sử Spotify để tính lượt nghe. AI là tuỳ chọn và dùng OpenAI API key nhập trong app, không phải mật khẩu Spotify hay gói ChatGPT.\n')
console.log(`Created and verified ${apk}`)
