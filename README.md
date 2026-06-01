# Dongtan CCTV Server

Railway Volume에 CCTV 녹화 파일을 저장하고, 송장번호 검색/스트리밍/다운로드 API를 제공하는 서버입니다.

## Railway 설정

이 `server` 폴더 안의 파일들이 Railway 서버 코드입니다.

### GitHub 저장소 루트에 파일을 직접 올리는 경우

1. `server` 폴더 안의 파일들을 GitHub 저장소 루트에 업로드합니다.
2. Railway 서비스 Settings > Source에서 Root Directory를 비워둡니다.
3. Railway Volume을 생성하고 mount path를 `/app/data`로 지정합니다.
4. Deploy합니다.

### GitHub 저장소에 `server` 폴더째 올리는 경우

1. GitHub 저장소에 `server/` 폴더를 업로드합니다.
2. Railway 서비스 Settings > Source에서 Root Directory를 `server`로 지정합니다.
3. Railway Volume을 생성하고 mount path를 `/app/data`로 지정합니다.
4. Deploy합니다.

## 환경변수

필수:

```env
CCTV_STORAGE_DIR=/app/data
```

선택:

```env
PORT=3000
CORS_ORIGIN=*
CCTV_MAX_UPLOAD_BYTES=1073741824
CCTV_DIRECT_MP4=0
```

업로드 토큰은 사용하지 않습니다. 내부용 서버 기준으로 누구나 업로드 가능하게 열어둔 구성입니다.

## API

- `GET /health`
- `POST /api/videos/upload`
  - multipart field: `video`
  - form field: `invoiceNumber`
- `GET /api/videos?invoice=송장번호`
- `GET /api/videos/:id/stream`
- `GET /api/videos/:id/download`
