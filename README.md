# Sóng

Ứng dụng tiếng Việt để tự động sắp xếp **Liked Songs** theo thể loại, ngôn ngữ hoặc thói quen nghe; tạo playlist riêng tư và chọn hàng loạt bài để bỏ thích. Mặc định mở thư viện Spotify trống; đăng nhập để lấy nhạc thật. Bản phát hành không hiển thị dữ liệu mẫu.

## Dùng thư viện của bạn

1. Bấm **Đăng nhập Spotify** để đồng bộ Liked Songs.
2. Bấm **Tự động sắp xếp**, chọn **Thể loại**, **Ngôn ngữ**, **Thể loại + ngôn ngữ** hoặc **Thói quen nghe / nghệ sĩ**.
3. Dùng **Gợi ý nhanh, không cần key**, hoặc chọn OpenAI nếu muốn gợi ý bằng AI. Xem lại những nhãn chưa chắc chắn; có thể chọn nhiều bài rồi sửa thể loại và ngôn ngữ bằng tay.
4. Trong **Nhóm theo gu**, tạo từng playlist hoặc bấm **Tạo nhiều playlist** để xem và chọn các nhóm trước khi tạo trên Spotify. Nhóm thiếu thông tin không được chọn mặc định. Các playlist được tạo là riêng tư; bài hát vẫn được giữ trong Liked Songs.
5. Nhập lịch sử nghe Spotify để lọc **Nghe nhiều / Bình thường / Ít nghe**, hoặc sắp xếp theo lần nghe gần nhất và lâu nhất. Chọn các bài muốn bỏ thích rồi xác nhận danh sách.

## Bản tải Android

`Song-Android.apk` dành cho **Android 8.0 trở lên**. Mở APK trên điện thoại; nếu Android yêu cầu, cho phép ứng dụng bạn dùng để mở file cài đặt từ nguồn đó. Bản APK được ký bằng khóa cục bộ của bản build, không phải bản phát hành Google Play. Không cần Node.js, npm hay tài khoản OpenAI để dùng chức năng lọc và gợi ý nhanh.

Giao diện chạy trong Android WebView; đăng nhập mở trang chính thức của Spotify trong trình duyệt hệ thống. Giữ Sóng đang mở khi đăng nhập để nhận phản hồi qua `http://127.0.0.1:43821/callback`, rồi quay lại app. Client ID công khai đã được cấu hình trong bản tải; URI này phải được đăng ký trong Spotify Developer Dashboard.

## Bản tải cho Mac chip M

Bản phát hành `Song-macOS-AppleSilicon.zip` chứa `Sóng.app`, dành cho **Apple Silicon, macOS 13 trở lên**. Giải nén, kéo app vào Applications rồi mở. App tự mở giao diện web trong trình duyệt mặc định, không cần Node.js hay npm. Một chương trình Go nhỏ chỉ phục vụ giao diện ở loopback `127.0.0.1:43821`; thư viện và thông tin đăng nhập vẫn nằm trong trình duyệt. Có thể dừng tiến trình `song` trong Activity Monitor khi không dùng.

Client ID được cấu hình sẵn trong bản build. Bấm **Đăng nhập Spotify** để đăng nhập và cấp quyền trên trang chính thức của Spotify. Redirect URI của bản tải là **`http://127.0.0.1:43821/callback`**; cần đăng ký đúng URI này trong Developer Dashboard. Chỉ Client ID công khai được đóng gói, không có Client Secret hay mật khẩu.

Bản app có chữ ký ad-hoc của trình biên dịch, chưa được ký / notarize bằng tài khoản Apple Developer. Nếu macOS chặn khi mở lần đầu, vào System Settings → Privacy & Security để xem và dùng Open Anyway nếu bạn quyết định chạy app. Không cần tắt Gatekeeper.

## Chạy app

Cần Node.js 22.12+ hoặc 24+. Trong môi trường cloud này dùng Node 24 đã cài sẵn.

```sh
cd /workspace/test
npm ci --cache /workspace/.cache/npm --no-audit --no-fund
npm run dev
```

App phát triển chạy ở cổng **5173**. Để kết nối Spotify bằng bản phát triển, mở bằng địa chỉ loopback `http://127.0.0.1:5173` và đăng ký chính xác Redirect URI `http://127.0.0.1:5173/`. Bản đóng gói dùng cổng 43821 và đường dẫn `/callback` như trên. Khi triển khai trên tên miền thật, dùng HTTPS và đăng ký callback đúng cấu hình. Spotify không chấp nhận `localhost` làm Redirect URI. Không có database hoặc backend dịch vụ cần cài thêm.

```sh
npm test
npm run build
```

Kiểm thử giao diện trên trình duyệt (trong cloud đã có Chromium):

```sh
npm run test:e2e
```

Trên máy khác, cài Chromium và đặt `CHROMIUM_PATH` tới file thực thi nếu nó không nằm ở `/usr/bin/chromium`. Bộ kiểm thử chạy server thử riêng khi chưa có server ở cổng 5173.

## Kết nối Spotify

1. Tạo app tại [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Đăng ký Redirect URI đúng với địa chỉ đang chạy app.
3. Nếu app đang ở Development Mode, kiểm tra điều kiện tài khoản / Premium hiện hành và thêm người dùng được phép truy cập trong Dashboard. Spotify có giới hạn riêng cho app mới; tài khoản Spotify thông thường chưa đảm bảo app developer được cấp quyền.
4. Trong Sóng, bấm **Đăng nhập Spotify** để đăng nhập trên trang chính thức của Spotify. Khi chưa cấu hình Client ID, app mở phần cấu hình; có thể chỉnh lại ID qua nút cài đặt kết nối. Bản tải đã được gắn Client ID.

Client ID là thông tin công khai. App dùng Authorization Code với **PKCE**, không cần Client Secret. Token chỉ lưu trong `sessionStorage`, được xoá khi ngắt kết nối; có thể thu hồi quyền trong tài khoản Spotify. Không gửi mật khẩu hoặc token qua chat, không commit thông tin xác thực.

Quyền sử dụng: đọc thư viện bài đã thích, chỉnh sửa thư viện và tạo playlist riêng tư. App chỉ bỏ thích sau khi bạn chọn bài và xác nhận danh sách. Việc tạo playlist không bỏ like các bài đó.

## Gợi ý thể loại, ngôn ngữ và AI

**Gợi ý nhanh** dùng tên bài, nghệ sĩ, album, nhãn đã có và các quy tắc nhận diện trong app. Khi bạn yêu cầu sắp xếp, app có thể đọc thêm thể loại nghệ sĩ công khai từ Spotify: tối đa 100 nghệ sĩ chưa có trong cache mỗi lần. Trường `genres` đã bị đánh dấu deprecated và có thể thiếu hoặc không được cấp quyền; khi Spotify chặn hay giới hạn yêu cầu, app giữ thông tin đã đọc được và tiếp tục bằng những nguồn còn lại. Không có yêu cầu bổ sung này khi chỉ mở app.

**Gợi ý bằng ChatGPT / OpenAI** là tùy chọn. Nhập OpenAI API key ngay trong màn hình sắp xếp; key chỉ nằm trong bộ nhớ của màn hình này, được xóa khi đóng, hoàn tất hoặc hủy, không ghi vào thư viện hay file xuất. OpenAI API tính phí riêng; gói ChatGPT không cung cấp API key hoặc bao gồm phí API.

Khi chọn AI, app gửi ID bài, tên bài, nghệ sĩ, album và các nhãn thể loại / ngôn ngữ đã có tới OpenAI để gợi ý nhãn. Không gửi token Spotify hoặc lịch sử nghe. Bản hiện tại dùng Responses API với `gpt-4.1-mini` và `store: false`. Chế độ gợi ý nhanh không gửi thư viện đến OpenAI.

Thể loại nghệ sĩ không chứng minh thể loại của từng bản thu; tên bài và tên nghệ sĩ cũng không chứng minh ngôn ngữ lời hát. Cả quy tắc và AI đều có thể nhận diện sai. Kết quả thiếu bằng chứng được để ở nhóm **Chưa rõ**; hãy xem lại và sửa nhãn trước khi tạo playlist. Những nhãn đã chỉnh bằng tay được giữ lại khi sắp xếp. App không phân tích âm thanh và không dùng Spotify audio features.

## Lượt nghe và độ tương đồng

- Nhập file JSON từ **Extended Streaming History** hoặc `StreamingHistory*.json` trong dữ liệu Spotify xuất từ mục quyền riêng tư. Giải nén trước khi nhập, nhập lần lượt các file nếu có nhiều file.
- Số lượt nghe chỉ tính các bản ghi nghe **ít nhất 30 giây**, trong khoảng lịch sử đã nhập: **nghe nhiều ≥10**, **bình thường 3–9**, **ít nghe 1–2**.
- Bài không có lượt phù hợp được ghi **Chưa ghi nhận**; điều này không có nghĩa bạn chưa từng nghe bài đó.
- File extended khớp bằng Spotify track ID; file cơ bản khớp tên bài và nghệ sĩ. Hai bản thu khác nhau có thể trùng tên; ưu tiên file extended để có kết quả rõ hơn.
- Lịch sử gần đây / top tracks của Web API không phải tổng lượt nghe. App không dùng ngày like thay cho lần nghe cuối.
- Chế độ **Thói quen nghe / nghệ sĩ** dùng lịch sử đã nhập để gom các bài thường nghe gần nhau. Thiếu bằng chứng thì gom cùng nghệ sĩ; nhãn thể loại bạn gán được ưu tiên. Đây là suy luận từ thói quen nghe, không phải đo độ giống nhau của âm thanh.

Thư viện, nhãn và lịch sử được giữ bằng IndexedDB trong trình duyệt hoặc WebView của bạn; chương trình phục vụ giao diện cục bộ không thu thập chúng. Có thể xuất thư viện thành JSON. Đổi trình duyệt, xóa dữ liệu website / ứng dụng hoặc gỡ app Android sẽ làm mất dữ liệu đã lưu. File xuất thư viện là bản để xem / lưu, không thay cho file Streaming History để nhập.

## Spotify Web API

App sử dụng các endpoint hiện hành: `GET /me/tracks` (50 bài / trang), `GET /artists/{id}` cho gợi ý tùy chọn, `POST /me/playlists`, `POST /playlists/{id}/items` (100 bài / lô), `DELETE /me/library` (40 URI / lô). Nếu thao tác nhiều lô bị lỗi giữa chừng, app chỉ cập nhật những bài Spotify đã xác nhận thành công. Khi tạo nhiều playlist, những nhóm đã tạo được giữ lại; thử tiếp chỉ xử lý nhóm chưa tạo. Playlist tạo một phần cần kiểm tra trên Spotify trước khi tạo lại.

Việc đăng nhập và thao tác với tài khoản thật cần Client ID, Redirect URI và quyền truy cập do Spotify cấp. Kiểm thử tự động dùng Spotify / OpenAI API mô phỏng, không đăng nhập tài khoản thật. Kiểm thử giao diện và callback trên cloud, kiểm tra chữ ký / cấu trúc gói, và kiểm thử chương trình phục vụ không thay cho chạy trên máy Mac hoặc điện thoại Android thật. Chưa xác nhận hành vi trên phần cứng native hay đăng nhập Spotify thật.

## Đóng gói từ mã nguồn

Các bản tải dùng cùng bản build web, với `VITE_SPOTIFY_REDIRECT_PATH=/callback` và `VITE_SPOTIFY_CLIENT_ID` là Client ID công khai của app. Thay `CLIENT_ID_CONG_KHAI` trong ví dụ bằng ID của bạn. Không đưa Spotify Client Secret hoặc OpenAI API key vào bản build.

Mac cần Go **1.27.1** và Python 3 ngoài Node.js; script biên dịch `darwin/arm64` và nhúng giao diện vào chương trình Go:

```sh
VITE_SPOTIFY_CLIENT_ID=CLIENT_ID_CONG_KHAI \
VITE_SPOTIFY_REDIRECT_PATH=/callback \
npm run package:mac
```

Android cần **SDK Platform Android 36**, **Build Tools 36.0.0**, Java **21** có module `jdk.compiler`, `keytool` và Python 3. Trong cloud, SDK nằm ở `/workspace/.tools/android-sdk`; có thể đặt `SONG_ANDROID_SDK` cho đường dẫn khác. Dùng các gói SDK chính thức và giữ kiểm tra checksum khi cài.

```sh
SONG_ANDROID_SDK=/workspace/.tools/android-sdk \
VITE_SPOTIFY_CLIENT_ID=CLIENT_ID_CONG_KHAI \
VITE_SPOTIFY_REDIRECT_PATH=/callback \
npm run package:android
```

Không cần Gradle. Script dùng AAPT2, `java --module jdk.compiler/com.sun.tools.javac.Main`, D8, zipalign và apksigner; vì vậy Java 21 có module compiler vẫn dùng được khi thiếu lệnh `javac`. Bản APK được căn chỉnh và kiểm tra chữ ký sau khi đóng gói. Khóa ký cục bộ nằm ngoài checkout ở `/workspace/.tools/android-signing`; giữ cùng khóa để các bản cập nhật cài được lên bản cũ. Các biến `SONG_JAVA_BINARY`, `SONG_KEYTOOL_BINARY`, `SONG_ANDROID_KEY_DIR`, `SONG_GO_BINARY` và `SONG_DOWNLOAD_DIR` cho phép đổi vị trí công cụ, khóa hoặc đầu ra.

## Phát triển trong cloud

Mỗi task đã có môi trường riêng; dùng checkout hiện có, không tạo Git worktree trừ khi được yêu cầu. `npm ci` giữ nguyên lockfile. Chỉ có Vite cần chạy lại khi máy được khôi phục; dependency và bản build có thể được giữ trong snapshot.

Mạng cài đặt cần `registry.npmjs.org`; tải Go từ `go.dev` / `dl.google.com` và Android SDK từ `dl.google.com` khi cần đóng gói. Tích hợp Spotify cần `accounts.spotify.com`, `api.spotify.com`, ảnh bìa có thể dùng `i.scdn.co`; AI tùy chọn cần `api.openai.com`. Không cần secret môi trường cho bước setup. Cổng mở hoặc tiến trình đang chạy chưa đủ: kiểm tra trang app và các thao tác tìm kiếm, lọc, sửa nhãn, xem trước playlist và xác nhận bỏ thích. Chỉ server phát triển có fixture `?demo=1` phục vụ kiểm thử; bản production bỏ qua tham số này và luôn dùng thư viện thật.
