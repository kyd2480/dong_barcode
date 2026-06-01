# Dongtan CCTV Server

Railway Volume에 CCTV 녹화 파일을 저장하고, 송장번호 검색/스트리밍/다운로드 API를 제공하는 서버입니다.

## Railway 설정

1. GitHub 저장소에 이 `railway-cctv-server` 폴더를 업로드합니다.
2. Railway 서비스 Settings > Source에서 Root Directory를 `railway-cctv-server`로 지정합니다.
3. Railway Volume을 생성하고 mount path를 `/app/data`로 지정합니다.
4. Variables에 `CCTV_UPLOAD_TOKEN` 값을 설정합니다.
5. Deploy합니다.

Railway가 `main` 브랜치를 못 찾는 경우 GitHub 저장소의 실제 기본 브랜치가 `master`인지 확인하거나, GitHub에서 `main` 브랜치를 생성한 뒤 Railway Source 브랜치를 다시 연결해야 합니다.

## API

- `GET /health`
- `POST /api/videos/upload`
  - multipart field: `video`
  - form field: `invoiceNumber`
  - optional header: `X-Upload-Token`
- `GET /api/videos?invoice=송장번호`
- `GET /api/videos/:id/stream`
- `GET /api/videos/:id/download`
